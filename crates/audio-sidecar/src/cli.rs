use crate::capture;
use crate::device;
use crate::health;
use crate::protocol::timestamp;
use cpal::traits::HostTrait;

#[derive(Default)]
struct Options {
    list_devices: bool,
    meter_only: bool,
    probe_only: bool,
    input_device_id: Option<String>,
    output_device_id: Option<String>,
}

fn parse(args: &[String]) -> Options {
    let mut options = Options {
        list_devices: args.iter().any(|arg| arg == "--list-devices"),
        meter_only: args.iter().any(|arg| arg == "--meter-only"),
        probe_only: args.iter().any(|arg| arg == "--probe-only"),
        ..Options::default()
    };
    for pair in args.windows(2) {
        if pair[0] == "--input-device-id" {
            options.input_device_id = Some(pair[1].clone());
        }
        if pair[0] == "--output-device-id" {
            options.output_device_id = Some(pair[1].clone());
        }
    }
    options
}

pub fn run() -> Result<(), String> {
    let args = std::env::args().collect::<Vec<_>>();
    let options = parse(&args);
    let host = cpal::default_host();
    if options.list_devices {
        let devices = device::enumerate(&host)?;
        println!(
            "{}",
            serde_json::to_string(&devices).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    health::starting();
    capture::run(
        options.input_device_id.as_deref(),
        options.output_device_id.as_deref(),
        options.meter_only,
        options.probe_only,
    )
    .map_err(|error| {
        health::failed(format!("{error} at {}", timestamp()));
        error
    })
}
