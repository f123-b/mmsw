"""Train and export the local interview speech-act classifier.

This is deliberately a small CPU-friendly ONNX model.  It is not presented as
MiniLM: the current artifact is a Chinese character n-gram classifier trained
on the domain dataset generated beside this file.  The application boundary is
model-agnostic, so a MiniLM/DistilBERT ONNX model can replace this artifact
later without changing the interview flow.
"""

from __future__ import annotations

import json
import platform
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import onnxruntime as ort
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.pipeline import Pipeline
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import StringTensorType


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
MODEL_DIR = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "models" / "question-classifier"


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def compose(item: dict) -> str:
    context = item.get("context") or []
    if not context:
        return f"当前面试发言：{item['text']}"
    return "上一轮面试对话：" + " | ".join(context) + f" 当前面试发言：{item['text']}"


def metrics(y_true: list[str], y_pred: list[str]) -> dict:
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "macroF1": float(f1_score(y_true, y_pred, average="macro")),
        "report": classification_report(y_true, y_pred, output_dict=True, zero_division=0),
    }


def predict_onnx(session: ort.InferenceSession, texts: list[str]) -> tuple[list[str], np.ndarray]:
    input_name = session.get_inputs()[0].name
    values = session.run(None, {input_name: np.asarray(texts, dtype=object)})
    labels: list[str] | None = None
    probabilities: np.ndarray | None = None
    for value in values:
        array = np.asarray(value)
        if array.dtype.kind in {"U", "S", "O"}:
            labels = [str(item) for item in array.reshape(-1).tolist()]
        elif array.ndim == 2 and array.shape[0] == len(texts):
            probabilities = array.astype(float)
    if probabilities is None:
        raise RuntimeError(f"ONNX model did not return a probability matrix: {[np.asarray(v).shape for v in values]}")
    if labels is None:
        # The converter normally returns a label tensor, but derive labels from
        # the probability index for compatibility with alternate exporters.
        classes = json.loads((MODEL_DIR / "labels.json").read_text(encoding="utf-8"))
        labels = [classes[int(index)] for index in probabilities.argmax(axis=1)]
    return labels, probabilities


def main() -> None:
    train_rows = load_jsonl(DATA_DIR / "train.jsonl")
    validation_rows = load_jsonl(DATA_DIR / "validation.jsonl")
    eval_rows = load_jsonl(DATA_DIR / "eval.jsonl")
    train_x = [compose(row) for row in train_rows]
    train_y = [row["label"] for row in train_rows]
    validation_x = [compose(row) for row in validation_rows]
    validation_y = [row["label"] for row in validation_rows]

    pipeline = Pipeline(
        [
            (
                "vectorizer",
                TfidfVectorizer(
                    analyzer="char",
                    ngram_range=(2, 5),
                    min_df=1,
                    sublinear_tf=True,
                    max_features=50000,
                    norm="l2",
                ),
            ),
            (
                "classifier",
                LogisticRegression(C=4.0, max_iter=3000, class_weight="balanced", random_state=20260821),
            ),
        ]
    )
    pipeline.fit(train_x, train_y)
    validation_pred = pipeline.predict(validation_x).tolist()

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    labels = [str(label) for label in pipeline.named_steps["classifier"].classes_.tolist()]
    (MODEL_DIR / "labels.json").write_text(json.dumps(labels, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    onnx_model = convert_sklearn(
        pipeline,
        initial_types=[("input", StringTensorType([None]))],
        options={id(pipeline.named_steps["classifier"]): {"zipmap": False}},
        target_opset=17,
    )
    (MODEL_DIR / "model.onnx").write_bytes(onnx_model.SerializeToString())

    session = ort.InferenceSession(str(MODEL_DIR / "model.onnx"), providers=["CPUExecutionProvider"])
    eval_x = [compose(row) for row in eval_rows]
    eval_y = [row["label"] for row in eval_rows]
    onnx_pred, eval_probabilities = predict_onnx(session, eval_x)

    result = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "runtime": "onnxruntime",
        "model": "char-ngram-tfidf-logistic-regression",
        "domains": ["embedded", "motor-control", "FOC", "power-electronics", "RTOS", "communication"],
        "labels": labels,
        "training": {"rows": len(train_rows), **metrics(train_y, pipeline.predict(train_x).tolist())},
        "validation": {"rows": len(validation_rows), **metrics(validation_y, validation_pred)},
        "handAuthoredEval": {"rows": len(eval_rows), **metrics(eval_y, onnx_pred)},
        "onnx": {
            "input": session.get_inputs()[0].name,
            "outputs": [output.name for output in session.get_outputs()],
            "probabilityShape": list(eval_probabilities.shape),
            "bytes": (MODEL_DIR / "model.onnx").stat().st_size,
        },
        "limitations": [
            "The hand-authored evaluation is a domain smoke test, not a substitute for a held-out human-labelled production corpus.",
            "This artifact is an ONNX text classifier, not a MiniLM transformer; the adapter boundary supports a later MiniLM export.",
            "The model predicts speech act (QUESTION/FOLLOW_UP/STATEMENT/OTHER), while question type and answer strategy remain in the shared rule/context layer.",
        ],
    }
    (MODEL_DIR / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (MODEL_DIR / "model-card.json").write_text(
        json.dumps(
            {
                "name": "mmsw-embedded-interview-speech-act-classifier",
                "description": "CPU-friendly local classifier for Chinese embedded, motor-control and power-electronics interview speech acts.",
                "trainingData": "Hand-authored interview questions, contextual follow-ups, candidate statements and spoken/ASR fragments generated by generate_dataset.py.",
                "labels": labels,
                "intendedUse": "Fast local stage-2 speech-act signal before shared rules, memory and selective LLM confirmation.",
                "outOfScope": ["answer generation", "personal profile extraction", "medical/legal/financial classification"],
                "evaluation": "See metrics.json; evaluation examples are kept separate from generated train/validation rows.",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("sample_predictions=")
    for item, prediction, probabilities in zip(eval_rows, onnx_pred, eval_probabilities):
        print(json.dumps({"text": item["text"], "expected": item["label"], "predicted": prediction, "confidence": round(float(probabilities.max()), 4)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
