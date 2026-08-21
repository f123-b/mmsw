"""Build a domain-specific interview speech-act dataset.

The examples are intentionally authored as interview utterances rather than
keyword-only sentences.  Every follow-up example carries the previous
interviewer/candidate exchange so that the classifier has to use context.
Generated files are local training artefacts and are ignored by git.
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"


def row(text: str, label: str, context: list[str] | None = None, domain: str = "embedded", scenario: str = "manual") -> dict:
    return {
        "text": text,
        "context": context or [],
        "label": label,
        "domain": domain,
        "scenario": scenario,
    }


QUESTION = [
    row("你在这个 FOC 项目里为什么把电流环放在 PWM 同步中断里？", "QUESTION", domain="foc", scenario="q-foc-current-loop"),
    row("能结合项目说一下，ADC 采样、DMA 搬运和控制计算之间是怎么衔接的吗？", "QUESTION", domain="foc", scenario="q-foc-sampling-chain"),
    row("如果采样噪声突然变大，你会先看哪些波形，怎么判断问题出在哪里？", "QUESTION", domain="foc", scenario="q-foc-noise"),
    row("低速运行出现周期性抖动时，你第一步会验证什么？", "QUESTION", domain="motor", scenario="q-low-speed-jitter"),
    row("为什么电流环的带宽通常要高于速度环？", "QUESTION", domain="motor", scenario="q-loop-bandwidth"),
    row("电流环和速度环的任务周期你会怎么安排？", "QUESTION", domain="motor", scenario="q-loop-period"),
    row("请解释一下中断快进快出的原则，最好结合你做过的控制任务。", "QUESTION", domain="rtos", scenario="q-isr"),
    row("DMA 和中断逐点搬运采样数据相比，各自的优缺点是什么？", "QUESTION", domain="embedded", scenario="q-dma-interrupt"),
    row("你这个项目为什么选择 CAN，而不是 UART 或 SPI？", "QUESTION", domain="communication", scenario="q-can-choice"),
    row("如果现场出现 CAN 丢帧，你会按什么顺序排查？", "QUESTION", domain="communication", scenario="q-can-debug"),
    row("状态机在电机控制项目里解决了什么问题？", "QUESTION", domain="embedded", scenario="q-state-machine"),
    row("优先级反转是怎么产生的？在 RTOS 里通常怎么避免？", "QUESTION", domain="rtos", scenario="q-priority-inversion"),
    row("如果让你重新设计这套电机控制软件，你最想先改哪一部分？为什么？", "QUESTION", domain="motor", scenario="q-redesign-control"),
    row("你会如何设计一个电机控制系统的任务优先级？", "QUESTION", domain="rtos", scenario="q-task-priority"),
    row("volatile 关键字在嵌入式项目里的作用和常见误区是什么？", "QUESTION", domain="embedded", scenario="q-volatile"),
    row("MOSFET 的开关损耗和导通损耗分别受哪些因素影响？", "QUESTION", domain="power", scenario="q-mosfet-loss"),
    row("为什么逆变器里需要设置死区？死区过大会有什么后果？", "QUESTION", domain="power", scenario="q-deadtime"),
    row("你在做 SVPWM 时，如何处理扇区判断和过调制问题？", "QUESTION", domain="power", scenario="q-svpwm"),
    row("Buck 电源的环路补偿你一般怎么验证稳定性？", "QUESTION", domain="power", scenario="q-buck-loop"),
    row("PFC 输入电流畸变比较大时，你会重点检查哪些环节？", "QUESTION", domain="power", scenario="q-pfc"),
    row("项目里遇到过最棘手的硬件或控制故障是什么？你是怎么定位的？", "QUESTION", domain="project", scenario="q-fault"),
    row("你主导过什么技术决策？当时为什么这样选，最后效果怎么样？", "QUESTION", domain="project", scenario="q-decision"),
    row("请介绍一下你主导过的电机控制项目，重点讲你负责的部分。", "QUESTION", domain="project", scenario="q-project-intro"),
    row("如果把编码器换成无感估算，你认为最大的难点是什么？", "QUESTION", domain="motor", scenario="q-sensorless"),
    row("你怎么证明这次优化确实降低了控制延迟，而不是测量误差？", "QUESTION", domain="project", scenario="q-measurement"),
    row("现场低速抖动时，你首先会看电流波形还是位置反馈？", "QUESTION", domain="motor", scenario="q-low-speed-signal"),
    row("你在项目里实际做过无感控制吗？", "QUESTION", domain="motor", scenario="q-sensorless-experience"),
    row("这个设计你能不能再说清楚一点？", "QUESTION", domain="clarification", scenario="q-clarify-design"),
    row("你能把刚才的判断依据讲得更具体一点吗？", "QUESTION", domain="clarification", scenario="q-clarify-evidence"),
    row("采样出现尖峰时，你会先确认哪一个时序关系？", "QUESTION", domain="foc", scenario="q-sampling-spike"),
    row("你有没有实际处理过优先级反转？当时怎么做的？", "QUESTION", domain="rtos", scenario="q-priority-experience"),
    row("遇到一个偶发复位问题时，你会怎么建立最小复现条件？", "QUESTION", domain="embedded", scenario="q-reset"),
    row("你会怎样验证一个采样链路在整个温度范围内都可靠？", "QUESTION", domain="power", scenario="q-validation"),
    row("面试中如果只用一句话说明闭环控制是什么，你会怎么说？", "QUESTION", domain="control", scenario="q-control-definition"),
    row("这个方案和直接放在线程里执行相比，实时性差异怎么评估？", "QUESTION", domain="rtos", scenario="q-thread-vs-isr"),
    row("你为什么没有把通信和数据记录放到最高优先级？", "QUESTION", domain="rtos", scenario="q-communication-priority"),
]


FOLLOW_UP = [
    row("那为什么不用中断？", "FOLLOW_UP", ["面试官：你使用 DMA 解决了采样数据搬运问题。", "候选人：对，DMA 负责把 ADC 结果放到缓冲区，CPU 处理控制算法。"], "foc", "fu-dma-vs-interrupt"),
    row("你刚才说的噪声，具体是怎么验证的？", "FOLLOW_UP", ["面试官：采样噪声变大时你会先看波形。", "候选人：我会对比 ADC 原始值、电流重构结果和 PWM 同步点。"], "foc", "fu-noise-verify"),
    row("好，说说你具体负责哪一段。", "FOLLOW_UP", ["面试官：介绍一下你的 FOC 项目。", "候选人：这个项目主要做永磁同步电机控制，我负责控制软件和采样链路。"], "project", "fu-project-responsibility"),
    row("那这个方案的代价是什么？", "FOLLOW_UP", ["面试官：你把控制计算放进了 PWM 同步中断。", "候选人：这样控制周期比较稳定，也减少了线程调度带来的抖动。"], "rtos", "fu-tradeoff"),
    row("如果改成双缓冲，你会怎么改？", "FOLLOW_UP", ["面试官：DMA 现在使用单缓冲搬运 ADC 数据。", "候选人：单缓冲实现简单，但处理和搬运的并行性还不够好。"], "embedded", "fu-double-buffer"),
    row("这个结论是怎么测出来的？", "FOLLOW_UP", ["面试官：你说这次优化把控制延迟降下来了。", "候选人：我用 GPIO 翻转配合示波器测了采样完成到 PWM 更新之间的时间。"], "project", "fu-measurement"),
    row("你刚才提到 CAN，具体用在哪些报文上？", "FOLLOW_UP", ["面试官：为什么选择 CAN 而不是 UART？", "候选人：现场节点比较多，而且需要一定的抗干扰和仲裁能力。"], "communication", "fu-can-usage"),
    row("那如果总线负载上升呢？", "FOLLOW_UP", ["面试官：CAN 的节点和报文会逐步增加。", "候选人：我会先统计周期报文占用，再区分控制、诊断和日志优先级。"], "communication", "fu-can-load"),
    row("你说的低速抖动，先排编码器还是先排电流采样？", "FOLLOW_UP", ["面试官：低速运行出现周期性抖动时你先验证什么？", "候选人：我会先同时保留电流和位置波形，再根据周期性和相位关系缩小范围。"], "motor", "fu-jitter-order"),
    row("这里的最难点具体是什么？", "FOLLOW_UP", ["面试官：介绍一下你主导的电机控制项目。", "候选人：项目从采样、控制计算到故障保护都需要我参与。"], "project", "fu-hardest-point"),
    row("那你怎么保证它不会影响控制周期？", "FOLLOW_UP", ["面试官：通信任务还要记录一些运行数据。", "候选人：我把数据放进环形缓冲区，低优先级任务再批量处理。"], "rtos", "fu-period-impact"),
    row("如果重新做一次，你会保留这个设计吗？", "FOLLOW_UP", ["面试官：你用状态机管理启动、运行和故障状态。", "候选人：状态边界比较清晰，现场问题也比较容易定位。"], "embedded", "fu-redesign-state"),
    row("为什么不是 UART？", "FOLLOW_UP", ["面试官：你这个项目为什么使用 CAN？", "候选人：现场有多个控制板，报文需要做优先级仲裁。"], "communication", "fu-can-uart"),
    row("你说的快进快出，具体哪些工作不能放在中断里？", "FOLLOW_UP", ["面试官：解释一下中断快进快出的原则。", "候选人：中断里只做采样确认、关键计算和结果更新，日志和复杂通信放到任务里。"], "rtos", "fu-isr-boundary"),
    row("那编码器异常时，控制环怎么处理？", "FOLLOW_UP", ["面试官：你项目里使用编码器闭环。", "候选人：正常情况下位置反馈参与换相和速度计算，异常时要进入保护或降级策略。"], "motor", "fu-encoder-fault"),
    row("你先从哪个信号开始看？", "FOLLOW_UP", ["面试官：现场出现一次偶发复位。", "候选人：我已经确认不是软件看门狗超时，怀疑供电或瞬态干扰。"], "embedded", "fu-reset-signal"),
    row("这个参数你是怎么算出来的？", "FOLLOW_UP", ["面试官：你把速度环周期设成了 1 毫秒。", "候选人：这个选择和机械惯量、目标带宽以及采样噪声都有关系。"], "control", "fu-loop-param"),
    row("那如果负载突然变化呢？", "FOLLOW_UP", ["面试官：电流环和速度环采用不同的带宽。", "候选人：电流环先快速跟随，速度环根据机械响应慢一些地调整给定。"], "control", "fu-load-change"),
    row("你怎么排除是硬件布局的问题？", "FOLLOW_UP", ["面试官：采样波形在高占空比时出现尖峰。", "候选人：我先换了已验证的软件配置，现象仍然存在。"], "power", "fu-layout"),
    row("如果器件温升继续上去，你会怎么处理？", "FOLLOW_UP", ["面试官：MOSFET 的损耗在满载时偏高。", "候选人：目前已经把导通损耗和开关损耗分开测量。"], "power", "fu-thermal"),
    row("这个故障后来定位到哪了？", "FOLLOW_UP", ["面试官：你刚才提到现场遇到过偶发故障。", "候选人：现象是低速时偶尔保护，复现概率不高。"], "project", "fu-fault-location"),
    row("先不用展开原理，项目里你是怎么做的？", "FOLLOW_UP", ["面试官：解释一下 SVPWM 的基本原理。", "候选人：我可以先讲扇区判断、作用时间计算和最终的比较值更新。"], "power", "fu-project-first"),
    row("那实际效果怎么量化？", "FOLLOW_UP", ["面试官：你把采样滤波策略做了优化。", "候选人：优化后波形更稳定，电流环的误差也降低了。"], "foc", "fu-effect"),
    row("你刚才说的保护阈值是怎么定的？", "FOLLOW_UP", ["面试官：过流保护需要在硬件比较器和软件里配合。", "候选人：硬件先保证快速关断，软件负责记录故障原因和恢复条件。"], "power", "fu-protection-threshold"),
    row("这个问题和你前面说的项目有什么关系？", "FOLLOW_UP", ["面试官：你在介绍一个通用的 RTOS 优先级原则。", "候选人：我在实际项目里把控制、诊断和日志拆成了不同任务。"], "project", "fu-context-link"),
]


STATEMENT = [
    row("CAN 主要用于工业现场的实时通信。", "STATEMENT", domain="communication", scenario="s-can-purpose"),
    row("电流环的带宽通常高于速度环。", "STATEMENT", domain="control", scenario="s-loop-bandwidth"),
    row("DMA 可以减少 CPU 搬运 ADC 采样数据的开销。", "STATEMENT", domain="embedded", scenario="s-dma"),
    row("这套控制器目前已经在台架上跑通了。", "STATEMENT", domain="project", scenario="s-bench"),
    row("这个故障最后定位到编码器线缆的屏蔽问题。", "STATEMENT", domain="motor", scenario="s-encoder-cable"),
    row("我们使用状态机管理启动、运行、停止和故障状态。", "STATEMENT", domain="embedded", scenario="s-state-machine"),
    row("控制计算放在 PWM 同步中断里，周期抖动会更小。", "STATEMENT", domain="foc", scenario="s-pwm-isr"),
    row("速度环的响应比电流环慢一些，这是机械惯性决定的。", "STATEMENT", domain="control", scenario="s-speed-response"),
    row("现场总线的报文已经按照控制、诊断和日志分了优先级。", "STATEMENT", domain="communication", scenario="s-bus-priority"),
    row("这次优化之后，采样完成到 PWM 更新之间的延迟下降了。", "STATEMENT", domain="project", scenario="s-latency"),
    row("过流保护由硬件比较器负责快速关断，软件负责记录原因。", "STATEMENT", domain="power", scenario="s-overcurrent"),
    row("死区太大时会造成电压利用率下降，电流波形也可能变差。", "STATEMENT", domain="power", scenario="s-deadtime"),
    row("MOSFET 满载发热主要和导通损耗、开关损耗以及散热条件有关。", "STATEMENT", domain="power", scenario="s-mosfet-loss"),
    row("目前这个偶发复位还没有稳定复现。", "STATEMENT", domain="embedded", scenario="s-reset"),
    row("我主要负责控制算法、采样链路和故障处理。", "STATEMENT", domain="project", scenario="s-responsibility"),
    row("这个项目的通信协议已经和上位机联调完成。", "STATEMENT", domain="project", scenario="s-protocol"),
    row("低速抖动的周期和编码器位置误差比较接近。", "STATEMENT", domain="motor", scenario="s-jitter"),
    row("我们在高低温和不同负载下都做过采样稳定性测试。", "STATEMENT", domain="validation", scenario="s-temperature"),
    row("滤波会降低噪声，但也会引入额外的相位延迟。", "STATEMENT", domain="control", scenario="s-filter"),
    row("通信和数据记录都放在低优先级任务里异步处理。", "STATEMENT", domain="rtos", scenario="s-logging"),
    row("这个问题不是软件逻辑导致的，最后发现是电源瞬态干扰。", "STATEMENT", domain="power", scenario="s-power-transient"),
    row("我用 GPIO 翻转和示波器测量了关键路径的执行时间。", "STATEMENT", domain="validation", scenario="s-measurement"),
    row("状态机就是根据当前状态和输入事件决定下一步动作。", "STATEMENT", domain="embedded", scenario="s-state-definition"),
    row("我会先看 ADC 原始值，再对照 PWM 同步时刻。", "STATEMENT", domain="foc", scenario="s-sampling-first"),
    row("这个版本没有做无感控制，当前使用的是编码器反馈。", "STATEMENT", domain="motor", scenario="s-no-sensorless"),
    row("我已经把这个设计的验证结果记录在测试报告里了。", "STATEMENT", domain="validation", scenario="s-test-report"),
    row("电机启动、运行和故障恢复分别对应状态机里的不同状态。", "STATEMENT", domain="embedded", scenario="s-motor-states"),
    row("这个判断是通过对比电流、位置和 PWM 三路波形得出的。", "STATEMENT", domain="validation", scenario="s-waveform-evidence"),
    row("PFC 的输入电流波形在满载时还有一定的畸变。", "STATEMENT", domain="power", scenario="s-pfc"),
    row("这个版本暂时只支持有感控制。", "STATEMENT", domain="motor", scenario="s-sensor"),
    row("项目中已经把启动、运行和故障处理拆成独立状态。", "STATEMENT", domain="embedded", scenario="s-states"),
]


OTHER = [
    row("嗯", "OTHER", scenario="o-um"),
    row("呃，先想一下", "OTHER", scenario="o-thinking"),
    row("好的，明白了", "OTHER", scenario="o-ack"),
    row("换个问题吧", "OTHER", scenario="o-change"),
    row("继续", "OTHER", scenario="o-continue"),
    row("十五秒", "OTHER", scenario="o-time"),
    row("我不太确定", "OTHER", scenario="o-uncertain"),
    row("嗯嗯，我听到了", "OTHER", scenario="o-heard"),
    row("那个，怎么说呢", "OTHER", scenario="o-filler"),
    row("好，可以", "OTHER", scenario="o-ok"),
    row("谢谢", "OTHER", scenario="o-thanks"),
    row("先说到这里", "OTHER", scenario="o-stop"),
    row("我需要整理一下思路", "OTHER", scenario="o-thinking-2"),
    row("这个我没有做过", "OTHER", scenario="o-no-experience"),
    row("可以再重复一下问题吗", "OTHER", scenario="o-repeat-request"),
    row("嗯，这个问题比较复杂", "OTHER", scenario="o-complex"),
    row("好的，下一个", "OTHER", scenario="o-next"),
    row("我先回答核心点", "OTHER", scenario="o-start"),
    row("明白你的意思了", "OTHER", scenario="o-understand"),
    row("暂时没有补充", "OTHER", scenario="o-no-more"),
]


def compose(context: list[str], text: str) -> str:
    if not context:
        return f"当前面试发言：{text}"
    return "上一轮面试对话：" + " | ".join(context) + f" 当前面试发言：{text}"


def variants(base: dict, index: int) -> list[dict]:
    """Add modest spoken-language variation without changing the speech act."""
    text = base["text"]
    label = base["label"]
    context = list(base["context"])
    outputs = [base]
    prefixes = {
        "QUESTION": ["", "我想结合项目问一下，", "你能结合实际说说，", "方便的话请你讲一下，"],
        "FOLLOW_UP": ["", "那具体来说，", "接着刚才这个，", "我再追问一句，"],
        "STATEMENT": ["", "我理解的是，", "目前的情况是，", "从项目现状看，"],
        "OTHER": ["", "嗯，", "呃，", "好，"],
    }[label]
    suffixes = {
        "QUESTION": ["", " 可以吗？", "，你怎么判断？"],
        "FOLLOW_UP": ["", "，你会怎么做？", "，能说具体一点吗？"],
        "STATEMENT": ["", "。", "，这是目前的结论。"],
        "OTHER": ["", "。"],
    }[label]
    for variant_index in range(1, 5):
        prefix = prefixes[(index + variant_index) % len(prefixes)]
        suffix = suffixes[(index * 2 + variant_index) % len(suffixes)]
        candidate = dict(base)
        candidate["text"] = prefix + text + suffix
        candidate["scenario"] = f"{base['scenario']}-v{variant_index}"
        candidate["variant_of"] = base["scenario"]
        outputs.append(candidate)
    # For follow-ups, occasionally include the preceding answer as a single
    # merged ASR turn. This mirrors the transcript shape seen in live use.
    if label == "FOLLOW_UP" and context and index % 2 == 0:
        merged = dict(base)
        merged["text"] = context[-1].replace("候选人：", "") + " 好，说说"
        merged["scenario"] = f"{base['scenario']}-merged"
        merged["variant_of"] = base["scenario"]
        outputs.append(merged)
    return outputs


def main() -> None:
    random.seed(20260821)
    base = QUESTION + FOLLOW_UP + STATEMENT + OTHER
    all_rows: list[dict] = []
    for index, item in enumerate(base):
        all_rows.extend(variants(item, index))

    # Duplicate only with deterministic re-ordering; group split below uses
    # variant_of, so no paraphrase of one scenario leaks into validation.
    random.shuffle(all_rows)
    train: list[dict] = []
    validation: list[dict] = []
    for item in all_rows:
        group = item.get("variant_of", item["scenario"])
        digest = int(hashlib.sha1(group.encode("utf-8")).hexdigest()[:8], 16)
        (validation if digest % 5 == 0 else train).append(item)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for path, rows in [(DATA_DIR / "train.jsonl", train), (DATA_DIR / "validation.jsonl", validation)]:
        path.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in rows) + "\n", encoding="utf-8")

    eval_rows = [
        row("你这个项目为什么使用 CAN？", "QUESTION"),
        row("CAN 主要用于工业通信。", "STATEMENT"),
        row("嗯", "OTHER"),
        row("你能讲一下电流环为什么要放在 PWM 同步中断里吗？", "QUESTION"),
        row("低速抖动的时候你先看什么？", "QUESTION"),
        row("如果采样噪声变大，你怎么验证？", "QUESTION"),
        row("那为什么不用 UART？", "FOLLOW_UP", ["面试官：你这个项目为什么使用 CAN？", "候选人：现场有多个节点，需要仲裁和抗干扰能力。"]),
        row("如果重新设计你会怎么做？", "FOLLOW_UP", ["面试官：介绍一下你的 FOC 项目。", "候选人：我主要负责电流采样、控制环和故障处理。"]),
        row("为什么不用编码器？", "FOLLOW_UP", ["面试官：你使用 DMA 解决了采样问题。", "候选人：DMA 负责搬运 ADC 结果，CPU 做控制计算。"]),
        row("好，说说", "FOLLOW_UP", ["面试官：介绍一下你的 FOC 项目。", "候选人：这是一个永磁同步电机控制项目。"]),
        row("这个代价是什么？", "FOLLOW_UP", ["面试官：你把控制计算放到中断里。", "候选人：这样周期更稳定，但中断执行时间需要严格控制。"]),
        row("你刚才提到 DMA，具体搬运的是哪一段？", "FOLLOW_UP", ["面试官：你使用 DMA 解决采样问题。", "候选人：我把 ADC 结果搬到双缓冲区，控制任务读取完整一帧数据。"]),
        row("CAN 和 UART 的区别我已经讲过了。", "STATEMENT", ["面试官：CAN 和 UART 都能传数据，你怎么选？", "候选人：我会根据节点数量、距离和抗干扰要求选择。"]),
        row("电流环更快，因为它离被控对象更近。", "STATEMENT"),
        row("我先整理一下思路。", "OTHER"),
        row("换一个问题。", "OTHER"),
        row("能不能再说清楚一点？", "QUESTION"),
        row("这个问题最后定位到电源瞬态干扰。", "STATEMENT"),
        row("你这个设计是怎么验证的？", "QUESTION"),
        row("那在高温下呢？", "FOLLOW_UP", ["面试官：你在高低温和不同负载下验证了采样稳定性。", "候选人：常温下波形和控制误差都满足要求。"]),
        row("请介绍一下你主导过的技术决策。", "QUESTION"),
        row("你刚才说的故障，后来怎么解决？", "FOLLOW_UP", ["面试官：说一个你遇到过的棘手故障。", "候选人：现场偶发过低速保护，复现概率比较低。"]),
        row("十五秒。", "OTHER"),
        row("状态机就是根据状态和事件决定下一步动作。", "STATEMENT"),
        row("如果让你重新排一次任务优先级呢？", "FOLLOW_UP", ["面试官：你把控制任务放在最高优先级。", "候选人：控制任务首先要保证周期稳定。"]),
        row("你有没有做过无感控制？", "QUESTION"),
        row("嗯，这块我没有实际做过。", "OTHER"),
        row("请问这个项目使用了哪种编码器？", "QUESTION"),
        row("目前这个版本只支持有感控制。", "STATEMENT"),
        row("那如果改成无感估算，难点在哪？", "FOLLOW_UP", ["面试官：目前版本使用增量式编码器。", "候选人：位置反馈用于换相和速度闭环。"]),
        row("我会先看 ADC 原始值和 PWM 同步点。", "STATEMENT"),
        row("能再重复一下刚才的问题吗？", "OTHER"),
    ]
    (DATA_DIR / "eval.jsonl").write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in eval_rows) + "\n", encoding="utf-8")

    summary = {
        "seed": 20260821,
        "base_examples": {"QUESTION": len(QUESTION), "FOLLOW_UP": len(FOLLOW_UP), "STATEMENT": len(STATEMENT), "OTHER": len(OTHER)},
        "train": len(train),
        "validation": len(validation),
        "eval": len(eval_rows),
        "notes": "Hand-authored Chinese embedded/motor-control/power-electronics interview turns with contextual follow-ups and ASR-like spoken fragments.",
    }
    (DATA_DIR / "dataset-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
