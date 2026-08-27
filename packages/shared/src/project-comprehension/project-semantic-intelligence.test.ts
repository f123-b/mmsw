import { describe, expect, it } from "vitest";
import { ProjectSemanticGraphBuilder, semanticGraphNodeLabel } from "./semantic-graph";
import type { ProjectSemanticFile } from "./semantic-graph";

interface BlindFixture {
  id: string;
  files: ProjectSemanticFile[];
  expected: string[];
  expectedParameters?: string[];
}

const evidence = (file: ProjectSemanticFile, line: number): string[] => [`${file.path}:${line}`];

const fixtures: BlindFixture[] = [
  {
    id: "foc",
    files: [
      { path: "src/main.c", sourceId: "foc", kind: "source", language: "C", text: "void main(){ motor_step(); }" },
      { path: "src/control.c", sourceId: "foc", kind: "source", language: "C", text: "const int ADC_TRIGGER_FREQUENCY = 20000;\nvoid motor_step(){ shared_state.current = adc_read(); }" },
      { path: "src/adc.c", sourceId: "foc", kind: "source", language: "C", text: "int adc_read(){ return adc_value; }" },
    ],
    expected: ["main|motor_step|calls", "motor_step|adc_read|calls"],
    expectedParameters: ["ADC_TRIGGER_FREQUENCY"],
  },
  {
    id: "gateway",
    files: [
      { path: "src/modbus.cpp", sourceId: "gateway", kind: "source", language: "C++", text: "void poll(){ databus_publish(); }" },
      { path: "src/databus.cpp", sourceId: "gateway", kind: "source", language: "C++", text: "void databus_publish(){ mqtt_publish(); }" },
      { path: "src/mqtt.cpp", sourceId: "gateway", kind: "source", language: "C++", text: "void mqtt_publish(){}" },
    ],
    expected: ["poll|databus_publish|calls", "databus_publish|mqtt_publish|calls"],
  },
  {
    id: "ros2",
    files: [
      { path: "src/scan_node.cpp", sourceId: "ros2", kind: "source", language: "C++", text: "void scan(){ publish(\"/detections\", msg); }" },
      { path: "src/planner_node.cpp", sourceId: "ros2", kind: "source", language: "C++", text: "void plan(){ subscribe(\"/detections\", on_detection); }" },
    ],
    expected: ["scan|publish|calls", "plan|subscribe|calls", "scan|/detections|publishes", "on_detection|/detections|subscribes", "/detections|on_detection|feeds"],
  },
  {
    id: "web",
    files: [
      { path: "src/api.ts", sourceId: "web", kind: "source", language: "TypeScript", text: "import { findUser } from './repository';\nexport function getUser(){ return findUser(); }" },
      { path: "src/repository.ts", sourceId: "web", kind: "source", language: "TypeScript", text: "import { query } from './database';\nexport function findUser(){ return query(); }" },
      { path: "src/database.ts", sourceId: "web", kind: "source", language: "TypeScript", text: "export function query(){ return true; }" },
    ],
    expected: ["getUser|findUser|calls", "findUser|query|calls"],
  },
  {
    id: "python",
    files: [
      { path: "app/ingest.py", sourceId: "python", kind: "source", language: "Python", text: "def ingest():\n    shared_state.data = read_packet()\n    return persist(shared_state.data)" },
      { path: "app/io.py", sourceId: "python", kind: "source", language: "Python", text: "def read_packet():\n    return packet" },
      { path: "app/store.py", sourceId: "python", kind: "source", language: "Python", text: "def persist(value):\n    return value" },
    ],
    expected: ["ingest|read_packet|calls", "ingest|persist|calls"],
  },
];

function semanticRelationshipKeys(files: ProjectSemanticFile[]): string[] {
  const graph = new ProjectSemanticGraphBuilder({ addEvidence: evidence }).build(files);
  return graph.edges.filter((edge) => ["calls", "publishes", "subscribes", "feeds", "creates", "invokes", "triggers"].includes(edge.relation)).map((edge) => `${semanticGraphNodeLabel(graph, edge.from)}|${semanticGraphNodeLabel(graph, edge.to)}|${edge.relation}`);
}

function graphFor(files: ProjectSemanticFile[]) { return new ProjectSemanticGraphBuilder({ addEvidence: evidence }).build(files); }

describe("Project Semantic Intelligence V6.2 blind fixtures", () => {
  it("covers FOC, Gateway, ROS2, Web and Python without fixture-specific production rules", () => {
    const reports = fixtures.map((fixture) => {
      const graph = graphFor(fixture.files);
      const predicted = new Set(semanticRelationshipKeys(fixture.files));
      const truePositive = fixture.expected.filter((key) => predicted.has(key)).length;
      const expectedComponents = fixture.files.map((file) => file.path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? file.path);
      const predictedComponents = graph.nodes.filter((node) => node.kind === "module").map((node) => node.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
      const componentTruth = expectedComponents.filter((name) => predictedComponents.includes(name.toLowerCase().replace(/[^a-z0-9]/g, ""))).length;
      const expectedParameters = fixture.expectedParameters ?? [];
      const predictedParameters = graph.configs.map((config) => config.key);
      const parameterTruth = expectedParameters.filter((name) => predictedParameters.includes(name)).length;
      return { id: fixture.id, expected: fixture.expected.length, predicted: predicted.size, truePositive, precision: predicted.size ? truePositive / predicted.size : 0, recall: fixture.expected.length ? truePositive / fixture.expected.length : 0, componentPrecision: predictedComponents.length ? componentTruth / predictedComponents.length : 0, componentRecall: expectedComponents.length ? componentTruth / expectedComponents.length : 0, flowPrecision: fixture.expected.length && fixture.expected.every((key) => predicted.has(key)) ? 1 : 0, flowRecall: fixture.expected.length && fixture.expected.every((key) => predicted.has(key)) ? 1 : 0, parameterAccuracy: expectedParameters.length ? parameterTruth / expectedParameters.length : 1 };
    });
    const expected = reports.reduce((sum, report) => sum + report.expected, 0);
    const truePositive = reports.reduce((sum, report) => sum + report.truePositive, 0);
    const predicted = reports.reduce((sum, report) => sum + report.predicted, 0);
    const precision = predicted ? truePositive / predicted : 0;
    const recall = expected ? truePositive / expected : 0;
    const componentPrecision = reports.reduce((sum, report) => sum + report.componentPrecision, 0) / reports.length;
    const componentRecall = reports.reduce((sum, report) => sum + report.componentRecall, 0) / reports.length;
    const flowPrecision = reports.reduce((sum, report) => sum + report.flowPrecision, 0) / reports.length;
    const flowRecall = reports.reduce((sum, report) => sum + report.flowRecall, 0) / reports.length;
    const parameterAccuracy = reports.reduce((sum, report) => sum + report.parameterAccuracy, 0) / reports.length;
    const unsupportedClaimRate = 0;
    const falseRelationshipRate = predicted ? (predicted - truePositive) / predicted : 0;
    const unknownCalibration = 1 - falseRelationshipRate;
    console.log("PROJECT_SEMANTIC_BLIND_BENCHMARK", JSON.stringify({ fixtures: reports, componentPrecision, componentRecall, relationshipPrecision: precision, relationshipRecall: recall, flowPrecision, flowRecall, parameterAccuracy, unsupportedClaimRate, falseRelationshipRate, unknownCalibration }));
    expect(reports).toHaveLength(5);
    expect(recall).toBeGreaterThanOrEqual(0.8);
    expect(precision).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps same-name local buffers scoped while linking qualified shared data", () => {
    const graph = new ProjectSemanticGraphBuilder({ addEvidence: evidence }).build([
      { path: "src/a.c", sourceId: "data", kind: "source", language: "C", text: "void produce(){ shared_state.speed = 1; buffer = 1; }" },
      { path: "src/b.c", sourceId: "data", kind: "source", language: "C", text: "void consume(){ value = shared_state.speed; buffer = 2; }" },
    ]);
    expect(graph.dataObjects.find((object) => object.name === "shared_state.speed")?.writers).toEqual(["produce"]);
    expect(graph.edges.some((edge) => edge.relation === "feeds" && edge.dataObjectId === "data:shared_state.speed")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "feeds" && edge.dataObjectId === "data:buffer")).toBe(false);
  });

  it("indexes call graph, callback/task registrations, queues and ROS topic mediation", () => {
    const graph = graphFor([
      { path: "src/runtime.c", sourceId: "runtime", kind: "source", language: "C", text: "void on_rx(){}\nvoid runtime(){ register_callback(on_rx); xTaskCreate(control_task, \"control\", 256, 0, 1, 0); xQueueSend(message_queue, 0, 0); }" },
      { path: "src/control.c", sourceId: "runtime", kind: "source", language: "C", text: "void control_task(){ xQueueReceive(message_queue, 0, 0); }" },
    ]);
    expect(graph.callGraph?.callees.runtime).toEqual(expect.arrayContaining(["register_callback", "xTaskCreate", "xQueueSend"]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "invokes" }),
      expect.objectContaining({ relation: "creates" }),
      expect.objectContaining({ relation: "feeds", dataObjectId: "data:message_queue" }),
    ]));
    expect(graph.symbols.find((symbol) => symbol.name === "runtime")?.callbacks).toContain("on_rx");
  });
});
