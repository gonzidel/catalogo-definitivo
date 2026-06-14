import CategoryIcon from "@/components/filters/CategoryIcon";
import { findCategory } from "@/lib/constants/categories";

interface CategoryContextBarProps {
  categoria: string;
  count: number;
  hideCount?: boolean;
}

export default function CategoryContextBar({
  categoria,
  count,
  hideCount = false,
}: CategoryContextBarProps) {
  const cat = findCategory(categoria);
  if (!cat) return null;

  return (
    <header className="category-context-bar" aria-label={`Categoría ${cat.label}`}>
      <div className="category-context-bar__icon" aria-hidden="true">
        <CategoryIcon id={cat.icon} />
      </div>

      <div className="category-context-bar__content">
        <div className="category-context-bar__title-row">
          <h2 className="category-context-bar__title">{cat.label}</h2>
          {!hideCount && count > 0 && (
            <span className="category-context-bar__badge">
              {count} producto{count !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <p className="category-context-bar__desc">{cat.desc}</p>
      </div>
    </header>
  );
}
