mod capture;
mod cli;
mod device;
mod health;
mod meter;
mod mixer;
mod packet;
mod protocol;
mod resample;

fn main() {
    if let Err(error) = cli::run() {
        eprintln!("audio-sidecar: {error}");
        std::process::exit(1);
    }
}
