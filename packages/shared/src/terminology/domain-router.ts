import { normalizeTerminologyToken } from "./token-normalizer";
import type { DomainRoute, TechnicalDomain } from "./terminology-types";

const DOMAIN_SIGNALS: Readonly<Record<TechnicalDomain, readonly string[]>> = {
  common_cs: ["数据结构", "操作系统", "计算机网络", "进程", "线程", "内存", "并发", "面向对象"],
  c_cpp: ["c语言", "c++", "c/c++", "指针", "模板", "stl", "虚函数", "编译器"],
  embedded: ["嵌入式", "stm32", "mcu", "freertos", "rtos", "i2c", "spi", "uart", "adc", "pwm", "foc", "sv​​pwm", "硬件", "单片机"],
  linux: ["linux", "内核", "驱动", "文件系统", "shell", "进程间通信", "rootfs", "设备树"],
  network: ["tcp", "udp", "http", "mqtt", "websocket", "网络", "socket", "协议", "三次握手"],
  database: ["mysql", "postgresql", "redis", "sql", "数据库", "索引", "事务", "缓存"],
  java: ["java", "jvm", "spring boot", "countdownlatch", "completablefuture", "threadpoolexecutor", "并发包"],
  backend: ["后端", "微服务", "服务端", "api", "网关", "消息队列", "kafka", "spring"],
  frontend: ["前端", "react", "vue", "typescript", "javascript", "浏览器", "css", "dom"],
  algorithm: ["算法", "链表", "二叉树", "排序", "动态规划", "复杂度", "图", "哈希"],
  ai_cv: ["ai", "机器学习", "深度学习", "pytorch", "yolo", "onnx", "transformer", "rag", "视觉"],
  fpga_ic: ["fpga", "verilog", "systemverilog", "uvm", "axi", "risc-v", "芯片", "时序"],
  devops: ["devops", "docker", "kubernetes", "k8s", "ci/cd", "jenkins", "部署", "监控"],
  motor_control: ["电机", "电机控制", "motor control", "pmsm", "bldc", "foc", "svpwm", "转矩", "位置环", "速度环", "电流环"],
  control_algorithm: ["控制算法", "控制理论", "pid", "卡尔曼", "状态空间", "闭环", "开环", "控制器"],
  robotics: ["机器人", "robotics", "机械臂", "移动机器人", "导航", "路径规划", "定位"],
  ros: ["ros", "ros2", "机器人操作系统", "节点", "topic", "service", "action", "colcon", "ament"],
  ai_application: ["ai应用", "人工智能应用", "大模型应用", "智能体", "agent", "rag", "向量数据库", "embedding", "提示词"],
  llm: ["llm", "大语言模型", "large language model", "prompt", "token", "上下文窗口", "function calling", "tool calling", "mcp"],
  computer_vision: ["计算机视觉", "computer vision", "图像识别", "目标检测", "分割", "多模态", "opencv"],
  computer_architecture: ["计算机体系结构", "computer architecture", "cpu", "缓存", "cache", "流水线", "指令集", "总线"],
  verification: ["验证", "verification", "验证平台", "uvm", "覆盖率", "断言", "形式验证", "testbench"],
  project: ["项目", "模块", "方案", "工程", "仓库", "源码"],
  resume: ["简历", "经历", "负责", "主导", "工作年限"],
  job: ["岗位", "jd", "职位", "招聘", "任职要求", "工作职责"]
};

const routeCache = new Map<string, DomainRoute>();

export interface DomainRouterInput {
  jd?: string;
  resume?: string;
  project?: string;
  currentTopic?: string;
  /** New direction resolver opts into additive domains; legacy callers do not. */
  includeExtendedDomains?: boolean;
}

export class DomainRouter {
  route(input: DomainRouterInput = {}): DomainRoute {
    const parts = [input.jd, input.resume, input.project, input.currentTopic].filter(Boolean).map((value) => normalizeTerminologyToken(value!));
    const cacheKey = parts.join("\n");
    const cacheLookupKey = `${input.includeExtendedDomains ? "extended" : "legacy"}\n${cacheKey}`;
    const cached = routeCache.get(cacheLookupKey);
    if (cached) return { ...cached, primaryDomains: [...cached.primaryDomains], secondaryDomains: [...cached.secondaryDomains] };
    const text = parts.join(" ");
    const scored = (Object.entries(DOMAIN_SIGNALS) as Array<[TechnicalDomain, readonly string[]]>).map(([domain, signals]) => ({
      domain,
      score: signals.reduce((total, signal) => total + (text.includes(normalizeTerminologyToken(signal)) ? 1 : 0), 0)
    })).sort((left, right) => right.score - left.score || left.domain.localeCompare(right.domain));
    const extendedDomains = new Set<TechnicalDomain>(["motor_control", "control_algorithm", "robotics", "ros", "ai_application", "llm", "computer_vision", "computer_architecture", "verification"]);
    const active = scored.filter((item) => item.score > 0 && (input.includeExtendedDomains || !extendedDomains.has(item.domain))).map((item) => item.domain);
    const primaryDomains = (active.length ? active.slice(0, 2) : ["common_cs", "project"] as TechnicalDomain[]);
    const secondaryDomains = active.filter((domain) => !primaryDomains.includes(domain)).slice(0, 4);
    const result = { primaryDomains, secondaryDomains, cacheKey };
    routeCache.set(cacheLookupKey, result);
    return { ...result, primaryDomains: [...result.primaryDomains], secondaryDomains: [...result.secondaryDomains] };
  }
}

export function clearDomainRouteCache(): void { routeCache.clear(); }
