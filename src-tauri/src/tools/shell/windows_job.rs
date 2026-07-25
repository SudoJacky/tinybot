use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(in crate::tools::shell) struct WindowsProcessJob {
    job: HANDLE,
}

// Windows kernel handles may be moved between threads; this type owns the handle and
// closes it exactly once in Drop.
unsafe impl Send for WindowsProcessJob {}

impl WindowsProcessJob {
    pub(in crate::tools::shell) fn new() -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(last_error("CreateJobObjectW"));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            let error = last_error("SetInformationJobObject");
            unsafe {
                CloseHandle(job);
            }
            return Err(error);
        }
        Ok(Self { job })
    }

    pub(in crate::tools::shell) fn assign(&self, child: &Child) -> io::Result<()> {
        let process = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(self.job, process) } == 0 {
            return Err(last_error("AssignProcessToJobObject"));
        }
        Ok(())
    }

    pub(in crate::tools::shell) fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            return Err(last_error("TerminateJobObject"));
        }
        Ok(())
    }
}

impl Drop for WindowsProcessJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.job);
        }
    }
}

fn last_error(operation: &str) -> io::Error {
    let code = unsafe { GetLastError() };
    io::Error::new(
        io::ErrorKind::Other,
        format!("{operation} failed with Windows error {code}"),
    )
}
