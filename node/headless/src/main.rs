#[tokio::main]
async fn main() {
    if let Err(error) = mere_run_node_headless::daemon::main().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
