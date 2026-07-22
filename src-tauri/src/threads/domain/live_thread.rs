use super::store::{MemoryThreadStore, ThreadStore};
use super::types::{
    AppendThreadItemsResult, ReadThreadRequest, ThreadItem, ThreadMetadataPatch, ThreadRecord,
    ThreadSnapshot,
};
use crate::protocol::WorkerProtocolError;

#[derive(Clone, Debug)]
pub struct LiveThread<S: ThreadStore = MemoryThreadStore> {
    thread_id: String,
    store: S,
}

impl<S: ThreadStore> LiveThread<S> {
    pub fn new(thread_id: impl Into<String>, store: S) -> Self {
        Self {
            thread_id: thread_id.into(),
            store,
        }
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn append(&self, item: ThreadItem) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_many(vec![item])
    }

    pub fn append_many(
        &self,
        items: Vec<ThreadItem>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.store.append_items(&self.thread_id, items)
    }

    pub fn append_with_client_event_id(
        &self,
        item: ThreadItem,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.append_many_with_client_event_id(vec![item], client_event_id)
    }

    pub fn append_many_with_client_event_id(
        &self,
        items: Vec<ThreadItem>,
        client_event_id: Option<&str>,
    ) -> Result<AppendThreadItemsResult, WorkerProtocolError> {
        self.store
            .append_items_with_client_event_id(&self.thread_id, items, client_event_id)
    }

    pub fn update_metadata(
        &self,
        patch: ThreadMetadataPatch,
    ) -> Result<ThreadRecord, WorkerProtocolError> {
        self.store.update_thread_metadata(&self.thread_id, patch)
    }

    pub fn snapshot(
        &self,
        cursor: Option<String>,
        limit: Option<usize>,
    ) -> Result<ThreadSnapshot, WorkerProtocolError> {
        self.store.read_thread(ReadThreadRequest {
            thread_id: self.thread_id.clone(),
            cursor,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: None,
            limit,
        })
    }
}
