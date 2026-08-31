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
}

export class DomainRouter {
  route(input: DomainRouterInput = {}): DomainRoute {
    const parts = [input.jd, input.resume, input.project, input.currentTopic].filter(Boolean).map((value) => normalizeTerminologyToken(value!));
    const cacheKey = parts.join("\n");
    const cached = routeCache.get(cacheKey);
    if (cached) return { ...cached, primaryDomains: [...cached.primaryDomains], secondaryDomains: [...cached.secondaryDomains] };
    const text = parts.join(" ");
    const scored = (Object.entries(DOMAIN_SIGNALS) as Array<[TechnicalDomain, readonly string[]]>).map(([domain, signals]) => ({
      domain,
      score: signals.reduce((total, signal) => total + (text.includes(normalizeTerminologyToken(signal)) ? 1 : 0), 0)
    })).sort((left, right) => right.score - left.score || left.domain.localeCompare(right.domain));
    const active = scored.filter((item) => item.score > 0).map((item) => item.domain);
    const primaryDomains = (active.length ? active.slice(0, 2) : ["common_cs", "project"] as TechnicalDomain[]);
    const secondaryDomains = active.filter((domain) => !primaryDomains.includes(domain)).slice(0, 4);
    const result = { primaryDomains, secondaryDomains, cacheKey };
    routeCache.set(cacheKey, result);
    return { ...result, primaryDomains: [...result.primaryDomains], secondaryDomains: [...result.secondaryDomains] };
  }
}

export function clearDomainRouteCache(): void { routeCache.clear(); }
