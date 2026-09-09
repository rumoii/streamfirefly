use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub length: u64,
}
