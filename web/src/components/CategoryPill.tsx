import { CATEGORY_COLORS, type Category } from "../lib/categories";

export function CategoryPill({ category }: { category: Category | null | undefined }) {
  if (!category) {
    return <span className="text-muted text-xs">unclassified</span>;
  }
  const color = CATEGORY_COLORS[category];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border"
      style={{ borderColor: `${color}40`, color, backgroundColor: `${color}1a` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {category}
    </span>
  );
}
