"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "./dashboard-icons";
type Props = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  icon?: IconName;
  kind?: "year" | "model";
  active?: boolean;
};
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  icon,
  kind,
  active = false,
}: Props) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLDivElement>(null),
    id = useId();
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }
  return (
    <div
      ref={root}
      className={[
        "filter-select",
        kind ? `select-${kind}` : "",
        active ? "is-filtered" : "",
        open ? "is-open" : "",
      ].join(" ")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="select-trigger"
        aria-label={`${label}：${options.find((o) => o.value === value)?.label ?? value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon && <Icon name={icon} />}
        <span
          className="select-value"
          title={options.find((o) => o.value === value)?.label ?? value}
        >
          {options.find((o) => o.value === value)?.label ?? value}
        </span>
        <svg
          className="select-chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      {open && (
        <div
          className="select-menu"
          role="listbox"
          aria-label={label}
          id={id}
          ref={list}
          onKeyDown={navigate}
        >
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              className="select-option"
              onClick={() => {
                onChange(option.value);
                close();
              }}
            >
              <span>{option.label}</span>
              <span className="select-check" aria-hidden="true">
                {option.value === value ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
