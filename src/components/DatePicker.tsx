interface DatePickerProps {
  value?: string | null;
  label: string;
  onChange: (value: string | null) => void;
}

export function DatePicker({ value, label, onChange }: DatePickerProps) {
  return (
    <label className="field-label compact-date">
      <span>{label}</span>
      <input type="date" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} />
    </label>
  );
}
