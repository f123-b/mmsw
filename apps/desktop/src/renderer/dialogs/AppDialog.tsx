import { useState, type FormEvent, type JSX } from "react";

export type DialogState = {
  kind: "form" | "confirm";
  title: string;
  description?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

interface AppDialogProps {
  dialog: DialogState;
  loading?: boolean;
  error?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function AppDialog({ dialog, loading = false, error, onConfirm, onCancel }: AppDialogProps): JSX.Element {
  const [value, setValue] = useState(dialog.defaultValue ?? "");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dialog.kind === "form" && dialog.required && !value.trim()) return;
    onConfirm(value);
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onCancel(); }}>
      <form className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" onSubmit={submit}>
        <header><div><span className="page-kicker">INTERVIEW COPILOT</span><h2 id="app-dialog-title">{dialog.title}</h2></div><button type="button" onClick={onCancel} disabled={loading} aria-label="关闭">×</button></header>
        {dialog.description && <p className="dialog-description">{dialog.description}</p>}
        {dialog.kind === "form" && <label className="clean-field"><span>{dialog.label ?? "名称"}</span>{dialog.multiline ? <textarea autoFocus rows={7} value={value} onChange={(event) => setValue(event.target.value)} placeholder={dialog.placeholder} /> : <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={dialog.placeholder} />}</label>}
        {error && <div className="dialog-error">{error}</div>}
        <footer><button type="button" className="outline-pill" onClick={onCancel} disabled={loading}>{dialog.cancelLabel ?? "取消"}</button><button type="submit" className="dark-pill" disabled={loading || (dialog.kind === "form" && dialog.required && !value.trim())}>{loading ? "处理中…" : (dialog.confirmLabel ?? "确认")}</button></footer>
      </form>
    </div>
  );
}
