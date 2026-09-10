use crate::capture_diagnostics::record;
use crate::capture_model::Session;
use crate::capture_storage::{append, save};
use serde_json::Value;
use std::io;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{accept_hdr_with_config, Message};
const MAX_CHUNK: usize = 256 * 1024;
pub(crate) fn receive(
    listener: TcpListener,
    origin: &str,
    token: &str,
    session: &Arc<Mutex<Session>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if session.lock().map_err(|_| "capture_unavailable")?.stop {
            return Err("capture_interrupted".into());
        }
        if Instant::now() >= deadline {
            return Err("capture_connection_timeout".into());
        }
        match listener.accept() {
            Ok((stream, address)) if address.ip().is_loopback() => {
                stream
                    .set_nonblocking(false)
                    .map_err(|_| "capture_socket_failed")?;
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| "capture_socket_failed")?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| "capture_socket_failed")?;
                let config = WebSocketConfig::default()
                    .max_message_size(Some(MAX_CHUNK + 4096))
                    .max_frame_size(Some(MAX_CHUNK + 4096));
                let socket = accept_hdr_with_config(
                    stream,
                    |request: &Request, response: Response| {
                        if request
                            .headers()
                            .get("origin")
                            .and_then(|value| value.to_str().ok())
                            != Some(origin)
                        {
                            return Err(tungstenite::http::Response::builder()
                                .status(403)
                                .body(Some("origin rejected".into()))
                                .unwrap());
                        }
                        Ok(response)
                    },
                    Some(config),
                );
                let Ok(mut socket) = socket else {
                    continue;
                };
                let authenticated = match socket.read() {
                    Ok(Message::Text(text)) => serde_json::from_str::<Value>(&text)
                        .ok()
                        .is_some_and(|value| value["token"].as_str() == Some(token)),
                    _ => false,
                };
                if !authenticated {
                    let _ = socket.close(None);
                    continue;
                }
                socket
                    .get_mut()
                    .set_read_timeout(Some(Duration::from_millis(250)))
                    .map_err(|_| "capture_socket_failed")?;
                {
                    let mut current = session.lock().map_err(|_| "capture_unavailable")?;
                    if current.stop {
                        return Err("capture_interrupted".into());
                    }
                    current.snapshot.state = "capturing".into();
                    save(&current).map_err(|_| "capture_checkpoint_failed")?;
                }
                socket
                    .send(Message::Text("{\"ready\":true}".into()))
                    .map_err(|_| "capture_disconnected")?;
                return receive_frames(socket, session);
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20))
            }
            Err(_) => return Err("capture_listener_failed".into()),
        }
    }
}

fn receive_frames(
    mut socket: tungstenite::WebSocket<TcpStream>,
    session: &Arc<Mutex<Session>>,
) -> Result<(), String> {
    let mut last_packet = Instant::now();
    loop {
        {
            let current = session.lock().map_err(|_| "capture_unavailable")?;
            if current.stop {
                let _ = socket.close(None);
                return if current.snapshot.state == "interrupted" {
                    Err("capture_interrupted".into())
                } else {
                    Ok(())
                };
            }
        }
        if last_packet.elapsed() > Duration::from_secs(30) {
            return Err("capture_idle_timeout".into());
        }
        match socket.read() {
            Ok(Message::Binary(bytes)) => {
                last_packet = Instant::now();
                let ack = append(session, &bytes)?;
                socket
                    .send(Message::Text(ack.to_string().into()))
                    .map_err(|_| "capture_ack_failed")?;
            }
            Ok(Message::Text(text)) if text == "ping" => {
                last_packet = Instant::now();
                socket
                    .send(Message::Text("{\"pong\":true}".into()))
                    .map_err(|_| "capture_disconnected")?;
            }
            Ok(Message::Text(text)) if text == "finish" => {
                let current = session.lock().map_err(|_| "capture_unavailable")?;
                record(
                    &current,
                    "finish-received",
                    serde_json::json!({"bytes":current.snapshot.bytes}),
                );
                return Ok(());
            }
            Ok(Message::Close(_)) => return Err("capture_disconnected".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if [io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut].contains(&error.kind()) => {
            }
            Err(_) => return Err("capture_disconnected".into()),
        }
    }
}
