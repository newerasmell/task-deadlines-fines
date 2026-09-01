import { colorForId, initials } from "../lib/colors";

export function Avatar({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const color = colorForId(id);
  return (
    <span
      className="avatar"
      style={{
        background: color,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
      }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}
