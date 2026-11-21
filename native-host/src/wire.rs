use serde_json::Value;
use std::io;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;

pub(crate) const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
pub(crate) type Writer = Arc<Mutex<io::BufWriter<io::Stdout>>>;

/// Why a message could not be read. `Eof` means the stream ended, `Invalid`
/// means one complete message carried unparseable JSON (the stream is still
/// aligned), and `Fatal` means the length prefix itself was unusable so the
/// stream is out of sync and must be dropped.
#[derive(Debug)]
pub(crate) enum WireError {
    Eof,
    Invalid,
    Fatal(io::Error),
}

pub(crate) fn read_message(reader: &mut impl Read) -> Result<Value, WireError> {
    let mut length = [0u8; 4];
    if reader.read_exact(&mut length).is_err() {
        return Err(WireError::Eof);
    }
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_MESSAGE_SIZE {
        return Err(WireError::Fatal(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message size",
        )));
    }
    let mut buf = vec![0; size];
    if reader.read_exact(&mut buf).is_err() {
        return Err(WireError::Eof);
    }
    serde_json::from_slice(&buf).map_err(|_| WireError::Invalid)
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

#[cfg(test)]
mod tests {
    use super::{read_message, WireError};
    use std::io::Cursor;

    fn framed(payload: &str) -> Vec<u8> {
        let mut bytes = (payload.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(payload.as_bytes());
        bytes
    }

    #[test]
    fn reads_a_message_after_an_invalid_one() {
        let mut stream = Cursor::new(
            framed("not json")
                .into_iter()
                .chain(framed("{\"type\":\"host.info\"}"))
                .collect::<Vec<_>>(),
        );
        match read_message(&mut stream) {
            Err(WireError::Invalid) => {}
            other => panic!("expected Invalid, got {:?}", other.is_ok()),
        }
        let message = read_message(&mut stream).expect("valid message after invalid one");
        assert_eq!(message["type"], "host.info");
    }

    #[test]
    fn eof_and_fatal_are_distinct() {
        let mut empty = Cursor::new(Vec::<u8>::new());
        assert!(matches!(read_message(&mut empty), Err(WireError::Eof)));
        let mut zero_length = Cursor::new(0u32.to_le_bytes().to_vec());
        assert!(matches!(
            read_message(&mut zero_length),
            Err(WireError::Fatal(_))
        ));
        let mut oversized =
            Cursor::new((super::MAX_MESSAGE_SIZE as u32 + 1).to_le_bytes().to_vec());
        assert!(matches!(
            read_message(&mut oversized),
            Err(WireError::Fatal(_))
        ));
    }
}
