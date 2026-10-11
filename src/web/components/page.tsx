import type { Child } from 'hono/jsx';

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: Child;
}) {
  return (
    <div class="page-header">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export function Breadcrumb({
  items,
}: {
  items: { label: string; href?: string }[];
}) {
  return (
    <div class="breadcrumb">
      {items.map((item, index) => (
        <>
          {index > 0 && <span>/</span>}
          {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
        </>
      ))}
    </div>
  );
}
