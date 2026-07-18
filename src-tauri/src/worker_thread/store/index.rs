use crate::worker_thread::types::ThreadRecord;

#[derive(Clone, Debug, Default)]
pub(super) struct ThreadIndex {
    pub(super) threads: Vec<ThreadRecord>,
}
