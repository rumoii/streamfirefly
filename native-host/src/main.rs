mod capture;
mod capture_catalog;
mod capture_diagnostics;
mod capture_merge;
mod capture_model;
mod capture_socket;
mod capture_storage;
mod dash;
mod dash_download;
mod hls;
mod hls_download;
mod hls_plan;
mod http_download;
mod integrations;
mod media_process;
mod model;
mod paths;
mod persistence;
mod processes;
mod protocol;
mod queue;
mod recovery;
mod repository;
mod runtime;
mod scheduler;
mod segment_transfer;
mod segments;
mod settings;
#[cfg(test)]
mod spec_tests;
mod task_control;
mod task_creation;
mod task_input;
mod task_runner;
mod task_state;
mod wire;
fn main() -> std::io::Result<()> {
    protocol::run()
}
