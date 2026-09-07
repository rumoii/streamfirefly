use serde_json::Value;
use std::io;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;

pub(crate) const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
pub(crate) type Writer = Arc<Mutex<io::BufWriter<io::Stdout>>>;
pub(crate) fn read_message(reader: &mut impl Read) -> io::Result<Value> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length)?;
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message size",
        ));
    }
    let mut buf = vec![0; size];
    reader.read_exact(&mut buf)?;
    serde_json::from_slice(&buf).map_err(io::Error::other)
}

pub(crate) fn write_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    writer.write_all(&(data.len() as u32).to_le_bytes())?;
    writer.write_all(&data)?;
    writer.flush()
}

pub(crate) fn emit(writer: &Writer, value: Value) {
    if let Ok(mut output) = writer.lock() {
        let _ = write_message(&mut *output, &value);
    }
}
