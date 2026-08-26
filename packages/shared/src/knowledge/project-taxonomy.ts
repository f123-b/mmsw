import { normalizeTechnicalTerms } from "../terminology";
import type { ProjectFact, ProjectTechnologyCategory, ProjectTechnologyGroup } from "./types";

const CATEGORY_LABELS: Record<ProjectTechnologyCategory, string> = {
  platform: "平台",
  mcu: "MCU",
  rtos: "RTOS",
  language: "语言",
  control: "控制算法",
  communication: "通信",
  sampling: "采样与外设",
  sensor: "Sensor",
  driver: "Driver",
  middleware: "中间件",
  build: "Build",
  linux: "OS",
  other: "其他"
};

export function normalizeTechnologyForDisplay(value: string): string {
  const normalized = normalizeTechnicalTerms(value).trim().replace(/\s+/g, " ");
  if (/^(?:iic|i2c)$/i.test(normalized)) return "I2C";
  if (/^(?:cpp|cxx|c\+\+)$/i.test(normalized)) return "C++";
  if (/^fdcan$/i.test(normalized)) return "FDCAN";
  if (/^rtos$/i.test(normalized)) return "RTOS";
  if (/^freertos$/i.test(normalized)) return "FreeRTOS";
  const mcu = normalized.match(/^(stm32[a-z]?\d+|esp32|rk\d+[a-z]?)$/i);
  if (mcu) return mcu[1].toUpperCase();
  return normalized;
}

export function normalizeTechnologies(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeTechnologyForDisplay(value);
    if (!normalized) continue;
    if (result.some((item) => item.toLowerCase() === normalized.toLowerCase())) continue;
    result.push(normalized);
  }
  if (result.some((item) => item === "FreeRTOS")) {
    for (let index = result.length - 1; index >= 0; index -= 1) if (result[index] === "RTOS") result.splice(index, 1);
  }
  const specificMcu = result.find((item) => /^(?:STM32[A-Z]?\d+|ESP32|RK\d+[A-Z]?)$/i.test(item));
  if (specificMcu) for (let index = result.length - 1; index >= 0; index -= 1) if (result[index] === "STM32" || result[index] === "MCU") result.splice(index, 1);
  return result;
}

export function classifyTechnology(value: string, factType?: ProjectFact["type"]): ProjectTechnologyCategory {
  const item = normalizeTechnologyForDisplay(value);
  if (/^(?:STM32(?:[A-Z]?\d+)?|ESP32|RK\d+[A-Z]?|MCU)$/i.test(item)) return "mcu";
  if (/^FreeRTOS$|^RTOS$|Zephyr|RT-Thread/i.test(item)) return "rtos";
  if (/^C(?:11)?$|^C\+\+$|^Python$|^Rust$|^CPP$/i.test(item)) return "language";
  if (/FOC|SVPWM|PID|Clarke|Park/i.test(item)) return "control";
  if (/CAN|FDCAN|UART|USART|SPI|I2C|USB CDC|Modbus|MQTT|SocketCAN/i.test(item)) return "communication";
  if (/ADC|DMA|PWM|采样|GPIO/i.test(item)) return "sampling";
  if (/AS5047P|MT6816|ABZ|编码器|传感器/i.test(item)) return "sensor";
  if (/DRV\d+|驱动器/i.test(item)) return "driver";
  if (/CMake|Make|Ninja/i.test(item)) return "build";
  if (/Linux|Ubuntu|Buildroot|Yocto/i.test(item)) return "linux";
  if (/LVGL|SQLite|ROS|LwIP|mbedTLS/i.test(item)) return "middleware";
  if (factType === "hardware") return "platform";
  return "other";
}

export function buildTechnologyTaxonomy(facts: ProjectFact[]): ProjectTechnologyGroup[] {
  const values = facts.filter((fact) => ["technology", "hardware", "software"].includes(fact.type)).map((fact) => ({ value: fact.title || fact.content, type: fact.type }));
  const grouped = new Map<ProjectTechnologyCategory, string[]>();
  for (const item of values) {
    const value = normalizeTechnologyForDisplay(item.value);
    if (!value) continue;
    const category = classifyTechnology(value, item.type);
    const items = grouped.get(category) ?? [];
    if (!items.some((existing) => existing.toLowerCase() === value.toLowerCase())) items.push(value);
    grouped.set(category, items);
  }
  const order: ProjectTechnologyCategory[] = ["platform", "mcu", "rtos", "language", "control", "communication", "sampling", "sensor", "driver", "middleware", "build", "linux", "other"];
  return order.flatMap((category) => {
    const items = normalizeTechnologies(grouped.get(category) ?? []);
    return items.length ? [{ category, label: CATEGORY_LABELS[category], items }] : [];
  });
}
