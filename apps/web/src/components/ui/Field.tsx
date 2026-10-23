import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import "./ui.css";

interface FieldProps {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}

/** Label + control + optional hint, wired together for accessibility. */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div className="wl-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="wl-hint">{hint}</span>}
    </div>
  );
}

export function TextInput({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return <Field label={label} hint={hint}>{(id) => <input id={id} className="wl-input" {...rest} />}</Field>;
}

export function TextArea({ label, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  return <Field label={label} hint={hint}>{(id) => <textarea id={id} className="wl-input wl-textarea" {...rest} />}</Field>;
}

export function Select({ label, hint, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} className="wl-input" {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}
