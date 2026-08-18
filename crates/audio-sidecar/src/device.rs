use crate::protocol::{DeviceInfo, DeviceList};
use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, Host};

pub fn device_id(device: &Device) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| device.to_string())
}

pub fn enumerate(host: &Host) -> Result<DeviceList, String> {
    let default_input = host.default_input_device().map(|device| device_id(&device));
    let default_output = host
        .default_output_device()
        .map(|device| device_id(&device));
    let inputs = host
        .input_devices()
        .map_err(|error| error.to_string())?
        .map(|device| {
            let id = device_id(&device);
            DeviceInfo {
                id: id.clone(),
                name: device.to_string(),
                kind: "microphone",
                default: default_input.as_deref() == Some(id.as_str()),
            }
        })
        .collect();
    let outputs = host
        .output_devices()
        .map_err(|error| error.to_string())?
        .map(|device| {
            let id = device_id(&device);
            DeviceInfo {
                id: id.clone(),
                name: device.to_string(),
                kind: "loopback",
                default: default_output.as_deref() == Some(id.as_str()),
            }
        })
        .collect();
    Ok(DeviceList { inputs, outputs })
}

pub fn select_input(host: &Host, id: Option<&str>) -> Result<Device, String> {
    if let Some(id) = id {
        return host
            .input_devices()
            .map_err(|error| error.to_string())?
            .find(|device| device_id(device) == id)
            .ok_or_else(|| format!("microphone not found: {id}"));
    }
    host.default_input_device()
        .ok_or_else(|| "default microphone not found".to_string())
}

pub fn select_output(host: &Host, id: Option<&str>) -> Result<Device, String> {
    if let Some(id) = id {
        return host
            .output_devices()
            .map_err(|error| error.to_string())?
            .find(|device| device_id(device) == id)
            .ok_or_else(|| format!("loopback output not found: {id}"));
    }
    host.default_output_device()
        .ok_or_else(|| "default output device not found".to_string())
}
