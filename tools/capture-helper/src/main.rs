#![allow(non_snake_case)]

#[cfg(not(windows))]
fn main() {
    println!(
        r#"{{"ok":false,"unsupported":true,"error":"Windows capture helper is only available on Windows"}}"#
    );
}

#[cfg(windows)]
mod windows_capture {
    use std::ffi::c_void;
    use std::fs;
    use std::mem::size_of;
    use std::path::Path;
    use std::ptr::null_mut;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::ImageFormat;
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    type Bool = i32;
    type Hdc = *mut c_void;
    type Hwnd = isize;
    type Hbitmap = *mut c_void;
    type Hgdiobj = *mut c_void;
    type Hhook = isize;

    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;
    const SRCCOPY: u32 = 0x00CC0020;
    const CAPTUREBLT: u32 = 0x40000000;
    const PW_RENDERFULLCONTENT: u32 = 0x00000002;
    const SM_XVIRTUALSCREEN: i32 = 76;
    const SM_YVIRTUALSCREEN: i32 = 77;
    const SM_CXVIRTUALSCREEN: i32 = 78;
    const SM_CYVIRTUALSCREEN: i32 = 79;
    const WH_MOUSE_LL: i32 = 14;
    const WM_MBUTTONDOWN: usize = 0x0207;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point { x: i32, y: i32 }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        wParam: usize,
        lParam: isize,
        time: u32,
        pt: Point,
        lPrivate: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BitmapInfoHeader {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RgbQuad {
        rgbBlue: u8,
        rgbGreen: u8,
        rgbRed: u8,
        rgbReserved: u8,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BitmapInfo {
        bmiHeader: BitmapInfoHeader,
        bmiColors: [RgbQuad; 1],
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetDC(hwnd: Hwnd) -> Hdc;
        fn ReleaseDC(hwnd: Hwnd, hdc: Hdc) -> i32;
        fn GetWindowDC(hwnd: Hwnd) -> Hdc;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> Bool;
        fn PrintWindow(hwnd: Hwnd, hdc: Hdc, flags: u32) -> Bool;
        fn GetSystemMetrics(index: i32) -> i32;
        fn IsWindow(hwnd: Hwnd) -> Bool;
        fn SetWindowsHookExW(idHook: i32, callback: Option<unsafe extern "system" fn(i32, usize, isize) -> isize>, instance: isize, threadId: u32) -> Hhook;
        fn CallNextHookEx(hook: Hhook, code: i32, wParam: usize, lParam: isize) -> isize;
        fn UnhookWindowsHookEx(hook: Hhook) -> Bool;
        fn GetMessageW(message: *mut Msg, hwnd: Hwnd, min: u32, max: u32) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn DeleteDC(hdc: Hdc) -> Bool;
        fn CreateDIBSection(
            hdc: Hdc,
            info: *const BitmapInfo,
            usage: u32,
            bits: *mut *mut c_void,
            section: *mut c_void,
            offset: u32,
        ) -> Hbitmap;
        fn SelectObject(hdc: Hdc, object: Hgdiobj) -> Hgdiobj;
        fn DeleteObject(object: Hgdiobj) -> Bool;
        fn BitBlt(
            dest: Hdc,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            source: Hdc,
            source_x: i32,
            source_y: i32,
            rop: u32,
        ) -> Bool;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }

    struct Args {
        mode: String,
        output: String,
        target: Option<String>,
        roi: Option<(i32, i32, i32, i32)>,
    }

    #[derive(Clone)]
    struct ModernCaptureFlags {
        output: String,
        roi: Option<(i32, i32, i32, i32)>,
        result: Arc<Mutex<Option<(i32, i32, Vec<u8>, usize)>>>,
    }

    struct ModernCapture {
        flags: ModernCaptureFlags,
    }

    impl GraphicsCaptureApiHandler for ModernCapture {
        type Flags = ModernCaptureFlags;
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self { flags: ctx.flags })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            frame.save_as_image(&self.flags.output, ImageFormat::Png)?;
            let width = frame.width() as i32;
            let height = frame.height() as i32;
            let mut no_padding = Vec::new();
            let raw = frame
                .buffer()?
                .as_nopadding_buffer(&mut no_padding)
                .to_vec();
            let marker = marker_pixels_bgra(&raw, width, height, self.flags.roi);
            let mut rgba = Vec::with_capacity(raw.len());
            for pixel in raw.chunks_exact(4) {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
            *self
                .flags
                .result
                .lock()
                .map_err(|_| "capture result lock poisoned")? = Some((width, height, rgba, marker));
            capture_control.stop();
            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    struct CapturedFrame {
        width: i32,
        height: i32,
        rgba: Vec<u8>,
        backend: &'static str,
        marker: usize,
    }

    fn parse_args() -> Result<Args, String> {
        let mut mode = None;
        let mut output = None;
        let mut target = None;
        let mut roi = None;
        let mut iter = std::env::args().skip(1);
        while let Some(arg) = iter.next() {
            let value =
                |name: &str, iter: &mut dyn Iterator<Item = String>| -> Result<String, String> {
                    iter.next()
                        .ok_or_else(|| format!("missing value for {name}"))
                };
            match arg.as_str() {
                "--mode" => mode = Some(value("--mode", &mut iter)?),
                "--output" => output = Some(value("--output", &mut iter)?),
                "--target" => target = Some(value("--target", &mut iter)?),
                "--roi" => {
                    let raw = value("--roi", &mut iter)?;
                    let values: Vec<i32> = raw
                        .split(',')
                        .map(|part| {
                            part.parse::<i32>()
                                .map_err(|_| format!("invalid roi: {raw}"))
                        })
                        .collect::<Result<_, _>>()?;
                    if values.len() != 4 {
                        return Err(format!("invalid roi: {raw}"));
                    }
                    roi = Some((values[0], values[1], values[2], values[3]));
                }
                _ => return Err(format!("unknown argument: {arg}")),
            }
        }
        let mode = mode.ok_or_else(|| "missing --mode".to_string())?;
        let output = if mode == "mouse-watch" { output.unwrap_or_default() } else { output.ok_or_else(|| "missing --output".to_string())? };
        Ok(Args {
            mode,
            output,
            target,
            roi,
        })
    }

    fn parse_hwnd(raw: &str) -> Result<Hwnd, String> {
        if raw.starts_with("0x") || raw.starts_with("0X") {
            isize::from_str_radix(&raw[2..], 16)
                .map_err(|_| format!("invalid window target: {raw}"))
        } else {
            raw.parse::<isize>()
                .map_err(|_| format!("invalid window target: {raw}"))
        }
    }

    fn make_bitmap_info(width: i32, height: i32) -> BitmapInfo {
        BitmapInfo {
            bmiHeader: BitmapInfoHeader {
                biSize: size_of::<BitmapInfoHeader>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RgbQuad {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }],
        }
    }

    fn modern_capture(
        mode: &str,
        target: Option<Hwnd>,
        output: &str,
        roi: Option<(i32, i32, i32, i32)>,
    ) -> Result<CapturedFrame, String> {
        let result = Arc::new(Mutex::new(None));
        let flags = ModernCaptureFlags {
            output: output.to_string(),
            roi,
            result: result.clone(),
        };
        let capture_control = if mode == "display" {
            let monitor = Monitor::primary().map_err(|error| error.to_string())?;
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::WithoutCursor,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            );
            ModernCapture::start_free_threaded(settings).map_err(|error| error.to_string())?
        } else {
            let hwnd = target.ok_or_else(|| "window mode requires --target HWND".to_string())?;
            let window = Window::from_raw_hwnd(hwnd as *mut c_void);
            let settings = Settings::new(
                window,
                CursorCaptureSettings::WithoutCursor,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            );
            ModernCapture::start_free_threaded(settings).map_err(|error| error.to_string())?
        };
        let started = Instant::now();
        let captured = loop {
            if let Some(frame) = result
                .lock()
                .map_err(|_| "capture result lock poisoned")?
                .take()
            {
                break frame;
            }
            if started.elapsed() > Duration::from_secs(3) {
                let _ = capture_control.stop();
                return Err("Windows Graphics Capture returned no frame before timeout".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let _ = capture_control.stop();
        Ok(CapturedFrame {
            width: captured.0,
            height: captured.1,
            rgba: captured.2,
            backend: "windows-graphics-capture",
            marker: captured.3,
        })
    }

    fn capture_display(
        output: &str,
        roi: Option<(i32, i32, i32, i32)>,
    ) -> Result<CapturedFrame, String> {
        if let Ok(frame) = modern_capture("display", None, output, roi) {
            return Ok(frame);
        }
        let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
        let (width, height, rgba) = capture_from_dc(0, x, y, width, height, false)?;
        let marker = marker_pixels(&rgba, width, height, roi);
        Ok(CapturedFrame {
            width,
            height,
            rgba,
            backend: "gdi-fallback",
            marker,
        })
    }

    fn capture_window(
        hwnd: Hwnd,
        output: &str,
        roi: Option<(i32, i32, i32, i32)>,
    ) -> Result<CapturedFrame, String> {
        if unsafe { IsWindow(hwnd) } == 0 {
            return Err(format!("target is not a window: {hwnd}"));
        }
        if let Ok(frame) = modern_capture("window", Some(hwnd), output, roi) {
            return Ok(frame);
        }
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return Err(format!("GetWindowRect failed: {}", unsafe {
                GetLastError()
            }));
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err(format!("window has invalid size: {width}x{height}"));
        }
        let (width, height, rgba) = capture_from_dc(hwnd, 0, 0, width, height, true)?;
        let marker = marker_pixels(&rgba, width, height, roi);
        Ok(CapturedFrame {
            width,
            height,
            rgba,
            backend: "gdi-fallback",
            marker,
        })
    }

    fn capture_from_dc(
        hwnd: Hwnd,
        source_x: i32,
        source_y: i32,
        width: i32,
        height: i32,
        window: bool,
    ) -> Result<(i32, i32, Vec<u8>), String> {
        let source = unsafe {
            if window {
                GetWindowDC(hwnd)
            } else {
                GetDC(0)
            }
        };
        if source.is_null() {
            return Err(format!("desktop DC unavailable: {}", unsafe {
                GetLastError()
            }));
        }
        let memory = unsafe { CreateCompatibleDC(source) };
        if memory.is_null() {
            unsafe {
                if window {
                    ReleaseDC(hwnd, source);
                } else {
                    ReleaseDC(0, source);
                }
            }
            return Err("compatible DC unavailable".to_string());
        }
        let info = make_bitmap_info(width, height);
        let mut pixels: *mut c_void = null_mut();
        let bitmap =
            unsafe { CreateDIBSection(source, &info, DIB_RGB_COLORS, &mut pixels, null_mut(), 0) };
        if bitmap.is_null() || pixels.is_null() {
            unsafe {
                DeleteDC(memory);
                if window {
                    ReleaseDC(hwnd, source);
                } else {
                    ReleaseDC(0, source);
                }
            }
            return Err("DIB section unavailable".to_string());
        }
        let previous = unsafe { SelectObject(memory, bitmap as Hgdiobj) };
        let captured = if window {
            unsafe {
                PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT) != 0
                    || BitBlt(
                        memory,
                        0,
                        0,
                        width,
                        height,
                        source,
                        0,
                        0,
                        SRCCOPY | CAPTUREBLT,
                    ) != 0
            }
        } else {
            unsafe {
                BitBlt(
                    memory,
                    0,
                    0,
                    width,
                    height,
                    source,
                    source_x,
                    source_y,
                    SRCCOPY | CAPTUREBLT,
                ) != 0
            }
        };
        let bytes = if captured {
            let raw = unsafe {
                std::slice::from_raw_parts(
                    pixels as *const u8,
                    (width as usize) * (height as usize) * 4,
                )
            };
            let mut rgba = Vec::with_capacity(raw.len());
            for pixel in raw.chunks_exact(4) {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
            }
            Some(rgba)
        } else {
            None
        };
        unsafe {
            SelectObject(memory, previous);
            DeleteObject(bitmap as Hgdiobj);
            DeleteDC(memory);
            if window {
                ReleaseDC(hwnd, source);
            } else {
                ReleaseDC(0, source);
            }
        }
        bytes
            .map(|value| (width, height, value))
            .ok_or_else(|| format!("capture operation failed: {}", unsafe { GetLastError() }))
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn adler32(bytes: &[u8]) -> u32 {
        let mut a = 1u32;
        let mut b = 0u32;
        for byte in bytes {
            a = (a + *byte as u32) % 65_521;
            b = (b + a) % 65_521;
        }
        (b << 16) | a
    }

    fn chunk(name: &[u8; 4], payload: &[u8], output: &mut Vec<u8>) {
        output.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        output.extend_from_slice(name);
        output.extend_from_slice(payload);
        output.extend_from_slice(&crc32(&[name.as_slice(), payload].concat()).to_be_bytes());
    }

    fn encode_png(width: i32, height: i32, rgba: &[u8]) -> Vec<u8> {
        let mut scanlines = Vec::with_capacity((width as usize * 4 + 1) * height as usize);
        for row in rgba.chunks_exact(width as usize * 4) {
            scanlines.push(0);
            scanlines.extend_from_slice(row);
        }
        let mut zlib = vec![0x78, 0x01];
        let mut offset = 0;
        while offset < scanlines.len() {
            let remaining = scanlines.len() - offset;
            let length = remaining.min(65_535);
            let final_block = offset + length == scanlines.len();
            zlib.push(if final_block { 1 } else { 0 });
            zlib.extend_from_slice(&(length as u16).to_le_bytes());
            zlib.extend_from_slice(&(!(length as u16)).to_le_bytes());
            zlib.extend_from_slice(&scanlines[offset..offset + length]);
            offset += length;
        }
        zlib.extend_from_slice(&adler32(&scanlines).to_be_bytes());
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut header = Vec::with_capacity(13);
        header.extend_from_slice(&width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(b"IHDR", &header, &mut png);
        chunk(b"IDAT", &zlib, &mut png);
        chunk(b"IEND", &[], &mut png);
        png
    }

    fn marker_pixels(
        rgba: &[u8],
        width: i32,
        height: i32,
        roi: Option<(i32, i32, i32, i32)>,
    ) -> usize {
        let (x, y, roi_width, roi_height) = roi.unwrap_or((0, 0, width, height));
        let left = x.max(0).min(width);
        let top = y.max(0).min(height);
        let right = (x + roi_width).max(left).min(width);
        let bottom = (y + roi_height).max(top).min(height);
        let mut count = 0;
        for row in top..bottom {
            for col in left..right {
                let index = ((row * width + col) * 4) as usize;
                if rgba[index + 3] > 160
                    && rgba[index] > 180
                    && rgba[index + 2] > 180
                    && rgba[index + 1] < 130
                {
                    count += 1;
                }
            }
        }
        count
    }

    fn marker_pixels_bgra(
        bgra: &[u8],
        width: i32,
        height: i32,
        roi: Option<(i32, i32, i32, i32)>,
    ) -> usize {
        let (x, y, roi_width, roi_height) = roi.unwrap_or((0, 0, width, height));
        let left = x.max(0).min(width);
        let top = y.max(0).min(height);
        let right = (x + roi_width).max(left).min(width);
        let bottom = (y + roi_height).max(top).min(height);
        let mut count = 0;
        for row in top..bottom {
            for col in left..right {
                let index = ((row * width + col) * 4) as usize;
                if bgra[index + 3] > 160
                    && bgra[index + 2] > 180
                    && bgra[index] > 180
                    && bgra[index + 1] < 130
                {
                    count += 1;
                }
            }
        }
        count
    }

    fn json_string(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 && wparam == WM_MBUTTONDOWN {
            println!(r#"{{"event":"middle-click"}}"#);
            let _ = io::stdout().flush();
        }
        CallNextHookEx(0, code, wparam, lparam)
    }

    fn watch_mouse() -> Result<(), String> {
        unsafe {
            let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), 0, 0);
            if hook == 0 { return Err(format!("SetWindowsHookExW failed: {}", GetLastError())); }
            println!(r#"{{"event":"ready"}}"#);
            let _ = io::stdout().flush();
            let mut message = std::mem::zeroed::<Msg>();
            while GetMessageW(&mut message, 0, 0, 0) > 0 {}
            UnhookWindowsHookEx(hook);
        }
        Ok(())
    }

    pub fn run() -> i32 {
        let args = match parse_args() {
            Ok(value) => value,
            Err(error) => {
                println!(
                    r#"{{"ok":false,"unsupported":false,"error":"{}"}}"#,
                    json_string(&error)
                );
                return 2;
            }
        };
        if args.mode == "mouse-watch" {
            return match watch_mouse() {
                Ok(()) => 0,
                Err(error) => { println!(r#"{{"event":"error","error":"{}"}}"#, json_string(&error)); 2 }
            };
        }
        let capture = match args.mode.as_str() {
            "display" => capture_display(&args.output, args.roi),
            "window" => match args.target.as_deref().map(parse_hwnd).transpose() {
                Ok(Some(hwnd)) => capture_window(hwnd, &args.output, args.roi),
                Ok(None) => Err("window mode requires --target HWND".to_string()),
                Err(error) => Err(error),
            },
            _ => Err(format!("unsupported capture mode: {}", args.mode)),
        };
        let captured = match capture {
            Ok(value) => value,
            Err(error) => {
                println!(
                    r#"{{"ok":false,"unsupported":true,"mode":"{}","error":"{}"}}"#,
                    json_string(&args.mode),
                    json_string(&error)
                );
                return 0;
            }
        };
        if let Some(parent) = Path::new(&args.output).parent() {
            let _ = fs::create_dir_all(parent);
        }
        if captured.backend == "gdi-fallback" {
            if let Err(error) = fs::write(
                &args.output,
                encode_png(captured.width, captured.height, &captured.rgba),
            ) {
                println!(
                    r#"{{"ok":false,"unsupported":false,"mode":"{}","error":"{}"}}"#,
                    json_string(&args.mode),
                    json_string(&error.to_string())
                );
                return 2;
            }
        }
        println!(
            r#"{{"ok":true,"unsupported":false,"mode":"{}","backend":"{}","image":"{}","width":{},"height":{},"markerDetected":{},"markerPixels":{}}}"#,
            json_string(&args.mode),
            captured.backend,
            json_string(&args.output),
            captured.width,
            captured.height,
            if captured.marker >= 500 {
                "true"
            } else {
                "false"
            },
            captured.marker
        );
        0
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_capture::run());
}
