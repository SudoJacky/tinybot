use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::mem::{replace, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, SetHandleInformation, SetLastError, ERROR_SUCCESS,
    HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, LUID, STILL_ACTIVE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    AdjustTokenPrivileges, CopySid, CreateRestrictedToken, CreateWellKnownSid, GetLengthSid,
    GetSidSubAuthority, GetTokenInformation, InitializeSid, LookupPrivilegeValueW,
    SetTokenInformation, TokenDefaultDacl, TokenGroups, TokenIntegrityLevel, WinNullSid,
    WinWorldSid, ACL, DISABLE_MAX_PRIVILEGE, LUA_TOKEN, LUID_AND_ATTRIBUTES, SECURITY_ATTRIBUTES,
    SECURITY_MANDATORY_LABEL_AUTHORITY, SECURITY_MAX_SID_SIZE, SE_PRIVILEGE_ENABLED,
    SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL, TOKEN_PRIVILEGES, TOKEN_QUERY, WRITE_RESTRICTED,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub(in crate::worker_shell) struct WindowsReadOnlySpawn {
    pub(in crate::worker_shell) process_id: u32,
    pub(in crate::worker_shell) stdin: File,
    pub(in crate::worker_shell) stdout: File,
    pub(in crate::worker_shell) stderr: File,
    pub(in crate::worker_shell) child: WindowsReadOnlyChild,
}

pub(in crate::worker_shell) struct WindowsReadOnlyChild {
    process: OwnedHandle,
    job: Option<OwnedHandle>,
}

impl WindowsReadOnlyChild {
    pub(in crate::worker_shell) fn try_wait(&mut self) -> io::Result<Option<i32>> {
        let wait = unsafe { WaitForSingleObject(self.process.raw(), 0) };
        match wait {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut exit_code = STILL_ACTIVE as u32;
                if unsafe { GetExitCodeProcess(self.process.raw(), &mut exit_code) } == 0 {
                    return Err(last_error("GetExitCodeProcess"));
                }
                if exit_code == STILL_ACTIVE as u32 {
                    return Err(io::Error::other(
                        "process signaled completion but still reports STILL_ACTIVE",
                    ));
                }
                self.job.take();
                Ok(Some(exit_code as i32))
            }
            other => Err(io::Error::other(format!(
                "WaitForSingleObject returned unexpected status {other}"
            ))),
        }
    }

    pub(in crate::worker_shell) fn terminate(&mut self) -> io::Result<()> {
        if self.try_wait()?.is_some() {
            return Ok(());
        }
        let Some(job) = self.job.as_ref() else {
            return Err(io::Error::other(
                "read-only shell job handle is unavailable while process is running",
            ));
        };
        if unsafe { TerminateJobObject(job.raw(), 1) } == 0 {
            return Err(last_error("TerminateJobObject"));
        }
        Ok(())
    }
}

pub(in crate::worker_shell) fn spawn_read_only_pipe_process(
    command: &str,
    working_dir: &Path,
) -> io::Result<WindowsReadOnlySpawn> {
    let token = create_read_only_token()?;
    let job = create_kill_on_close_job()?;
    let stdin = create_child_read_pipe()?;
    let stdout = create_child_write_pipe()?;
    let stderr = create_child_write_pipe()?;
    let inherited_handles = [stdin.child.raw(), stdout.child.raw(), stderr.child.raw()];
    let mut attributes = ProcessAttributeList::with_handle_list(&inherited_handles)?;

    let command_shell = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    let application = wide_null(command_shell.as_os_str());
    let command_line = format!(
        "{} /D /S /C {}",
        quote_windows_argument(command_shell.as_os_str()),
        quote_windows_argument(OsStr::new(command))
    );
    let mut command_line = wide_null(OsStr::new(&command_line));
    let working_dir = super::super::process_working_dir(working_dir);
    let working_dir = wide_null(working_dir.as_os_str());
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.child.raw();
    startup.StartupInfo.hStdOutput = stdout.child.raw();
    startup.StartupInfo.hStdError = stderr.child.raw();
    startup.lpAttributeList = attributes.raw();
    let mut process = PROCESS_INFORMATION::default();
    let creation_flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;
    let created = unsafe {
        CreateProcessAsUserW(
            token.raw(),
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            creation_flags,
            null(),
            working_dir.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessAsUserW"));
    }

    let process_handle = OwnedHandle::new(process.hProcess, "CreateProcessAsUserW process")?;
    let thread_handle = OwnedHandle::new(process.hThread, "CreateProcessAsUserW thread")?;
    if unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) } == 0 {
        let error = last_error("AssignProcessToJobObject");
        terminate_suspended_process(process_handle.raw());
        return Err(error);
    }
    let resume_result = unsafe { ResumeThread(thread_handle.raw()) };
    if resume_result == u32::MAX {
        let error = last_error("ResumeThread");
        let _ = unsafe { TerminateJobObject(job.raw(), 1) };
        let _ = unsafe { WaitForSingleObject(process_handle.raw(), 2_000) };
        return Err(error);
    }

    drop(thread_handle);
    drop(attributes);
    drop(stdin.child);
    drop(stdout.child);
    drop(stderr.child);

    Ok(WindowsReadOnlySpawn {
        process_id: process.dwProcessId,
        stdin: owned_handle_into_file(stdin.parent),
        stdout: owned_handle_into_file(stdout.parent),
        stderr: owned_handle_into_file(stderr.parent),
        child: WindowsReadOnlyChild {
            process: process_handle,
            job: Some(job),
        },
    })
}

fn create_read_only_token() -> io::Result<OwnedHandle> {
    let mut base_token = null_mut();
    let desired_access = TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_PRIVILEGES
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_DUPLICATE
        | TOKEN_QUERY;
    if unsafe { OpenProcessToken(GetCurrentProcess(), desired_access, &mut base_token) } == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    let base_token = OwnedHandle::new(base_token, "OpenProcessToken")?;

    let mut null_sid = well_known_sid(WinNullSid, "WinNullSid")?;
    let mut logon_sid = logon_sid(base_token.raw())?;
    let mut world_sid = well_known_sid(WinWorldSid, "WinWorldSid")?;
    let restricting_sids = [
        SID_AND_ATTRIBUTES {
            Sid: null_sid.as_mut_ptr().cast(),
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: logon_sid.as_mut_ptr().cast(),
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: world_sid.as_mut_ptr().cast(),
            Attributes: 0,
        },
    ];
    let mut restricted_token = null_mut();
    let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    if unsafe {
        CreateRestrictedToken(
            base_token.raw(),
            flags,
            0,
            null(),
            0,
            null(),
            restricting_sids.len() as u32,
            restricting_sids.as_ptr(),
            &mut restricted_token,
        )
    } == 0
    {
        return Err(last_error("CreateRestrictedToken"));
    }
    let restricted_token = OwnedHandle::new(restricted_token, "CreateRestrictedToken")?;
    set_token_default_dacl(
        restricted_token.raw(),
        &[logon_sid.as_mut_ptr().cast(), world_sid.as_mut_ptr().cast()],
    )?;
    set_low_integrity_level(restricted_token.raw())?;
    enable_change_notify_privilege(restricted_token.raw())?;
    Ok(restricted_token)
}

fn set_low_integrity_level(token: HANDLE) -> io::Result<()> {
    const SECURITY_MANDATORY_LOW_RID: u32 = 0x1000;
    const SE_GROUP_INTEGRITY: u32 = 0x20;

    let mut sid = [0u8; SECURITY_MAX_SID_SIZE as usize];
    let sid_pointer = sid.as_mut_ptr().cast();
    if unsafe { InitializeSid(sid_pointer, &SECURITY_MANDATORY_LABEL_AUTHORITY, 1) } == 0 {
        return Err(last_error("InitializeSid(low integrity)"));
    }
    let sub_authority = unsafe { GetSidSubAuthority(sid_pointer, 0) };
    if sub_authority.is_null() {
        return Err(io::Error::other(
            "GetSidSubAuthority returned null for low-integrity SID",
        ));
    }
    unsafe {
        *sub_authority = SECURITY_MANDATORY_LOW_RID;
    }
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid_pointer,
            Attributes: SE_GROUP_INTEGRITY,
        },
    };
    let label_size =
        size_of::<TOKEN_MANDATORY_LABEL>() + unsafe { GetLengthSid(sid_pointer) } as usize;
    if unsafe {
        SetTokenInformation(
            token,
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            label_size as u32,
        )
    } == 0
    {
        return Err(last_error("SetTokenInformation(TokenIntegrityLevel)"));
    }
    Ok(())
}

#[repr(C)]
struct TokenDefaultDaclInformation {
    default_dacl: *mut ACL,
}

fn set_token_default_dacl(token: HANDLE, sids: &[*mut std::ffi::c_void]) -> io::Result<()> {
    const GENERIC_ALL: u32 = 0x1000_0000;

    let entries = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: (*sid).cast(),
            },
        })
        .collect::<Vec<_>>();
    let mut dacl = null_mut();
    let result =
        unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), null(), &mut dacl) };
    if result != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let mut information = TokenDefaultDaclInformation { default_dacl: dacl };
    let set_result = unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            (&mut information as *mut TokenDefaultDaclInformation).cast(),
            size_of::<TokenDefaultDaclInformation>() as u32,
        )
    };
    let set_error = (set_result == 0).then(io::Error::last_os_error);
    unsafe {
        LocalFree(dacl.cast());
    }
    if let Some(source) = set_error {
        return Err(io::Error::new(
            source.kind(),
            format!("SetTokenInformation(TokenDefaultDacl) failed: {source}"),
        ));
    }
    Ok(())
}

fn enable_change_notify_privilege(token: HANDLE) -> io::Result<()> {
    let privilege_name = wide_null(OsStr::new("SeChangeNotifyPrivilege"));
    let mut luid = LUID::default();
    if unsafe { LookupPrivilegeValueW(null(), privilege_name.as_ptr(), &mut luid) } == 0 {
        return Err(last_error("LookupPrivilegeValueW(SeChangeNotifyPrivilege)"));
    }
    let mut privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        ..Default::default()
    };
    privileges.Privileges[0] = LUID_AND_ATTRIBUTES {
        Luid: luid,
        Attributes: SE_PRIVILEGE_ENABLED,
    };
    unsafe {
        SetLastError(ERROR_SUCCESS);
    }
    if unsafe { AdjustTokenPrivileges(token, 0, &privileges, 0, null_mut(), null_mut()) } == 0 {
        return Err(last_error("AdjustTokenPrivileges(SeChangeNotifyPrivilege)"));
    }
    let result = unsafe { GetLastError() };
    if result != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    Ok(())
}

fn well_known_sid(sid_type: i32, name: &str) -> io::Result<Vec<u8>> {
    let mut sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut sid_size = sid.len() as u32;
    if unsafe { CreateWellKnownSid(sid_type, null_mut(), sid.as_mut_ptr().cast(), &mut sid_size) }
        == 0
    {
        return Err(last_error(&format!("CreateWellKnownSid({name})")));
    }
    sid.truncate(sid_size as usize);
    Ok(sid)
}

fn logon_sid(token: HANDLE) -> io::Result<Vec<u8>> {
    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

    let mut required = 0u32;
    unsafe {
        GetTokenInformation(token, TokenGroups, null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(last_error("GetTokenInformation(TokenGroups) size"));
    }
    let mut groups = vec![0u8; required as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            groups.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation(TokenGroups)"));
    }

    let group_count = unsafe { groups.as_ptr().cast::<u32>().read_unaligned() } as usize;
    let after_count = unsafe { groups.as_ptr().add(size_of::<u32>()) } as usize;
    let alignment = std::mem::align_of::<SID_AND_ATTRIBUTES>();
    let aligned_groups = (after_count + alignment - 1) & !(alignment - 1);
    let entries = aligned_groups as *const SID_AND_ATTRIBUTES;
    let groups_end = groups.as_ptr() as usize + groups.len();
    let available_entries =
        groups_end.saturating_sub(aligned_groups) / size_of::<SID_AND_ATTRIBUTES>();
    if group_count > available_entries {
        return Err(io::Error::other(format!(
            "TokenGroups declared {group_count} groups but only {available_entries} fit in the returned buffer"
        )));
    }
    for index in 0..group_count {
        let entry = unsafe { entries.add(index).read_unaligned() };
        if entry.Attributes & SE_GROUP_LOGON_ID != SE_GROUP_LOGON_ID {
            continue;
        }
        let sid_size = unsafe { GetLengthSid(entry.Sid) };
        if sid_size == 0 {
            return Err(last_error("GetLengthSid(logon SID)"));
        }
        let mut sid = vec![0u8; sid_size as usize];
        if unsafe { CopySid(sid_size, sid.as_mut_ptr().cast(), entry.Sid) } == 0 {
            return Err(last_error("CopySid(logon SID)"));
        }
        return Ok(sid);
    }
    Err(io::Error::other(
        "current process token does not contain a logon SID",
    ))
}

fn create_kill_on_close_job() -> io::Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    let job = OwnedHandle::new(job, "CreateJobObjectW")?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

struct ChildPipe {
    child: OwnedHandle,
    parent: OwnedHandle,
}

fn create_child_read_pipe() -> io::Result<ChildPipe> {
    let (read, write) = create_inheritable_pipe()?;
    clear_inherit(write.raw())?;
    Ok(ChildPipe {
        child: read,
        parent: write,
    })
}

fn create_child_write_pipe() -> io::Result<ChildPipe> {
    let (read, write) = create_inheritable_pipe()?;
    clear_inherit(read.raw())?;
    Ok(ChildPipe {
        child: write,
        parent: read,
    })
}

fn create_inheritable_pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok((
        OwnedHandle::new(read, "CreatePipe read")?,
        OwnedHandle::new(write, "CreatePipe write")?,
    ))
}

fn clear_inherit(handle: HANDLE) -> io::Result<()> {
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(last_error("SetHandleInformation"));
    }
    Ok(())
}

struct ProcessAttributeList {
    storage: Vec<usize>,
    initialized: bool,
}

impl ProcessAttributeList {
    fn with_handle_list(handles: &[HANDLE]) -> io::Result<Self> {
        let mut bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(last_error("InitializeProcThreadAttributeList size"));
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut list = Self {
            storage: vec![0usize; words],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(list.raw(), 1, 0, &mut bytes) } == 0 {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        list.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                list.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error("UpdateProcThreadAttribute(handle list)"));
        }
        Ok(list)
    }

    fn raw(&mut self) -> *mut std::ffi::c_void {
        self.storage.as_mut_ptr().cast()
    }
}

impl Drop for ProcessAttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { DeleteProcThreadAttributeList(self.raw()) };
        }
    }
}

struct OwnedHandle(HANDLE);

unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    fn new(handle: HANDLE, operation: &str) -> io::Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(last_error(operation));
        }
        Ok(Self(handle))
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        replace(&mut self.0, null_mut())
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn owned_handle_into_file(handle: OwnedHandle) -> File {
    unsafe { File::from_raw_handle(handle.into_raw() as RawHandle) }
}

fn terminate_suspended_process(process: HANDLE) {
    unsafe {
        TerminateProcess(process, 1);
        WaitForSingleObject(process, 2_000);
    }
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn quote_windows_argument(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.into_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
            continue;
        }
        quoted.push_str(&"\\".repeat(backslashes));
        backslashes = 0;
        quoted.push(character);
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn last_error(operation: &str) -> io::Error {
    let source = io::Error::last_os_error();
    io::Error::new(source.kind(), format!("{operation} failed: {source}"))
}
