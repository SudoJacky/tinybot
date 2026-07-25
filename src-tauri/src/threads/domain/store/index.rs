use crate::threads::domain::types::ThreadRecord;

#[derive(Clone, Debug, Default)]
pub(super) struct ThreadIndex {
    pub(super) threads: Vec<ThreadRecord>,
}
