'use client';

import { useState } from 'react';
import { Leaf, Plus, Store, UtensilsCrossed } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { inr, useMe, type Catalog, type MenuItem } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { DemoBanner } from '@/components/restaurant/overview';

export default function MenuPage() {
  const me = useMe();
  const { data: menu, error, reload } = useApi<Catalog>('/restaurant/menu', 0);
  const [adding, setAdding] = useState(false);
  const canEdit = !!me && me.role !== 'viewer';
  const isAdmin = me?.role === 'admin';

  return (
    <>
      <PageHeader
        title="Menu"
        actions={
          isAdmin && (
            <Button variant="primary" onClick={() => setAdding((v) => !v)}>
              <Plus className="size-4" /> Add item
            </Button>
          )
        }
      />
      {(menu?.items.some((i) => i.isDemo) || menu?.outlets.some((o) => o.isDemo)) && (
        <DemoBanner>
          <b>Demo menu.</b> Items marked “Demo” have placeholder prices. Edit them here to the verified GR Chicken prices; the AI only ever quotes what is saved on this page.
        </DemoBanner>
      )}
      {error && !menu && <ErrorBanner message={error} onRetry={reload} />}
      {adding && menu && <AddItem categories={menu.categories} onDone={() => (setAdding(false), reload())} />}

      {!menu ? (
        <Skeleton className="h-[480px] rounded-[14px]" />
      ) : !menu.items.length ? (
        <Card>
          <Empty icon={<UtensilsCrossed className="size-6" />} title="No menu yet">
            Run <code>npm run seed:gr-chicken</code> for the demo menu, or add items.
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {menu.categories.map((c) => {
            const items = menu.items.filter((i) => i.categoryId === c.id);
            if (!items.length) return null;
            return (
              <Card key={c.id}>
                <CardHeader title={c.name} subtitle={`${items.filter((i) => i.available).length} of ${items.length} available`} />
                <ul className="divide-y divide-line border-t border-line">
                  {items.map((i) => (
                    <ItemRow key={i.id} item={i} canEdit={canEdit} onSaved={reload} />
                  ))}
                </ul>
              </Card>
            );
          })}

          <Card>
            <CardHeader title="Outlets" subtitle="Hours, delivery areas and fees used when validating orders" />
            <ul className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-2">
              {menu.outlets.map((o) => (
                <li key={o.id} className="rounded-[12px] border border-line p-4 text-[13px]">
                  <p className="flex items-center gap-2 font-semibold text-ink">
                    <Store className="size-4 text-muted" /> {o.name}
                    {o.isDemo && <Badge tone="amber">Demo</Badge>}
                    {!o.active && <Badge tone="rose">Inactive</Badge>}
                  </p>
                  <p className="mt-1 text-muted">{o.address}</p>
                  <p className="mt-2 text-body">
                    Open {o.opensAt}–{o.closesAt} IST{o.acceptOutsideHours ? ' · accepts orders outside hours (testing)' : ''}
                  </p>
                  <p className="text-body">
                    {[o.acceptsPickup && 'Pickup', o.acceptsDelivery && `Delivery ${inr(o.deliveryFee)}`].filter(Boolean).join(' · ')} · Min order {inr(o.minOrderValue)}
                  </p>
                  {o.acceptsDelivery && <p className="mt-1 text-[12px] text-muted">Delivers to: {o.serviceAreas.join(', ') || '—'}</p>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

function ItemRow({ item, canEdit, onSaved }: { item: MenuItem; canEdit: boolean; onSaved: () => void }) {
  const [price, setPrice] = useState(String(item.price));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = Number(price) !== item.price;

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/restaurant/menu/items/${item.id}`, patch);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-[200px] flex-1">
        <p className={cx('flex items-center gap-2 text-[13.5px] font-semibold', item.available ? 'text-ink' : 'text-faint line-through')}>
          {item.name}
          {item.isVeg && <Leaf className="size-3.5 text-brand" aria-label="Vegetarian" />}
          {item.isDemo && <Badge tone="amber">Demo</Badge>}
        </p>
        {item.description && <p className="text-[12px] text-muted">{item.description}</p>}
        {item.aliases.length > 0 && <p className="text-[11.5px] text-faint">Also understood as: {item.aliases.join(', ')}</p>}
        {err && <p className="mt-1 text-[12px] text-rose">{err}</p>}
      </div>
      {canEdit ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save({ price: Number(price) });
          }}
        >
          <label className="flex h-9 items-center rounded-[10px] border border-line bg-white px-2 text-[13px]">
            <span className="text-muted">₹</span>
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              aria-label={`Price of ${item.name}`}
              className="tabular w-16 bg-transparent px-1 text-right font-semibold text-ink outline-none"
            />
          </label>
          {dirty && (
            <Button type="submit" variant="primary" busy={busy} className="h-9">
              Save
            </Button>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] font-semibold text-muted">
            <input type="checkbox" checked={item.available} disabled={busy} onChange={(e) => save({ available: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />
            Available
          </label>
        </form>
      ) : (
        <p className="tabular text-[14px] font-bold text-ink">{inr(item.price)}</p>
      )}
    </li>
  );
}

function AddItem({ categories, onDone }: { categories: Catalog['categories']; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', price: '', categoryId: categories[0]?.id ?? '', description: '', aliases: '', isVeg: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  const input = 'h-9 rounded-[10px] border border-line bg-white px-3 text-[13px] text-ink';

  return (
    <Card className="mb-4 p-5">
      <form
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api.post('/restaurant/menu/items', { ...form, price: Number(form.price) });
            onDone();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input required placeholder="Item name" value={form.name} onChange={set('name')} className={input} aria-label="Item name" />
        <input required inputMode="decimal" placeholder="Price (₹)" value={form.price} onChange={set('price')} className={input} aria-label="Price" />
        <select value={form.categoryId} onChange={set('categoryId')} className={input} aria-label="Category">
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input placeholder="Description (optional)" value={form.description} onChange={set('description')} className={cx(input, 'md:col-span-2')} aria-label="Description" />
        <input placeholder="Other names, comma separated" value={form.aliases} onChange={set('aliases')} className={input} aria-label="Other names" />
        <label className="inline-flex items-center gap-2 text-[13px] text-body">
          <input type="checkbox" checked={form.isVeg} onChange={set('isVeg')} className="size-4" /> Vegetarian
        </label>
        <div className="flex items-center gap-2 md:col-span-2 md:justify-end">
          {err && <span className="text-[12.5px] text-rose">{err}</span>}
          <Button type="submit" variant="primary" busy={busy}>
            Add to menu
          </Button>
        </div>
      </form>
    </Card>
  );
}
