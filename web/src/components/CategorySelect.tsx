import { CATEGORIES, type Category } from "../lib/categories";

interface Props {
  value: Category | null;
  onChange: (next: Category) => void;
  disabled?: boolean;
  className?: string;
}

export function CategorySelect({ value, onChange, disabled, className = "" }: Props) {
  return (
    <select
      className={`input ${className}`}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Category)}
    >
      {value === null && <option value="">—</option>}
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}
