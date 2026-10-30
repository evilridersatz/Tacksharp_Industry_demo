'use client';

import { useState } from 'react';
import { Plus, Scissors, Store, UtensilsCrossed } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { inr, qty, useMe, type Catalog, type MenuItem } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { DemoBanner } from '@/components/restaurant/overview';

export default function ProductsPage() {
  const me = useMe();
  const { data: menu, error, reload } = useApi<Catalog>('/restaurant/menu', 0);
  const [adding, setAdding] = useState(false);
  const canEdit = !!me && me.role !== 'viewer';
  const isAdmin = me?.role === 'admin';

  return (
    <>
      <PageHeader
        title="Products & rates"
        crumb="Products"
        actions={
          isAdmin && (
            <Button variant="primary" onClick={() => setAdding((v) => !v)}>
              <Plus className="size-4" /> Add product
            </Button>
          )
        }
      />
      {(menu?.items.some((i) => i.isDemo) || menu?.outlets.some((o) => o.isDemo)) && (
        <DemoBanner>
          <b>Demo rates and stock.</b> Products marked “Demo” have placeholder per-kg prices, and “Demo stock” numbers are samples. Set today&apos;s real rates and counted stock here — the assistant (WhatsApp and phone) only ever quotes what is saved on this page.
        </DemoBanner>
      )}
      {error && !menu && <ErrorBanner message={error} onRetry={reload} />}
      {adding && menu && (menu.categories.length ? <AddProduct categories={menu.categories} onDone={() => (setAdding(false), reload())} /> : <Card className="mb-4 p-5"><p className="mb-2 text-[13px] text-body">Products belong to a category. Add one first.</p><AddCategory onDone={reload} /></Card>)}

      {!menu ? (
        <Skeleton className="h-[480px] rounded-[14px]" />
      ) : (
        <div className="flex flex-col gap-4">
          {!menu.items.length && (
            <Card>
              <Empty icon={<UtensilsCrossed className="size-6" />} title="No products yet">
                {isAdmin ? 'Add a category (for example "Chicken" or "Eggs"), then your products with their price per kg or per piece. Your AI assistant only quotes what you save here.' : 'Ask your admin to add the products and prices.'}
              </Empty>
              {isAdmin && <div className="px-5 pb-5"><AddCategory onDone={reload} /></div>}
            </Card>
          )}
          {menu.categories.map((c) => {
            const items = menu.items.filter((i) => i.categoryId === c.id);
            if (!items.length) return null;
            return (
              <Card key={c.id}>
                <CardHeader title={c.name} subtitle={`${items.filter((i) => i.available).length} of ${items.length} available today`} />
                <ul className="divide-y divide-line border-t border-line">
                  {items.map((i) => (
                    <ProductRow key={i.id} item={i} canEdit={canEdit} onSaved={reload} />
                  ))}
                </ul>
              </Card>
            );
          })}

          <Card>
            <CardHeader title="Shops" subtitle="Where customers pick up, opening hours and preparation time used when they choose a pickup time" action={isAdmin ? <AddOutletButton onDone={reload} /> : undefined} />
            {!menu.outlets.length && <p className="px-5 pb-3 text-[13px] text-amber-900">No shop yet: add at least one so customers can choose where to pick up.</p>}
            <ul className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-2">
              {menu.outlets.map((o) => (
                <li key={o.id} className="rounded-[12px] border border-line p-4 text-[13px]">
                  <p className="flex items-center gap-2 font-semibold text-ink">
                    <Store className="size-4 text-muted" /> {o.name}
                    {o.isDemo && <Badge tone="amber">Demo</Badge>}
                    {!o.active && <Badge tone="rose">Closed</Badge>}
                  </p>
                  <p className="mt-1 text-muted">{o.address}</p>
                  <p className="mt-2 text-body">
                    Open {o.opensAt}–{o.closesAt} IST · {o.prepMinutes} min to cut & pack
                    {o.minOrderValue > 0 ? ` · min order ${inr(o.minOrderValue)}` : ''}
                  </p>
                  {o.acceptOutsideHours && <p className="mt-1 text-[12px] text-[#b45309]">Accepts pickup times outside opening hours (testing setting).</p>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

function ProductRow({ item, canEdit, onSaved }: { item: MenuItem; canEdit: boolean; onSaved: () => void }) {
  const [price, setPrice] = useState(String(item.price));
  const [cuts, setCuts] = useState(item.cutOptions.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = Number(price) !== item.price || cuts.trim() !== item.cutOptions.join(', ');
  const per = item.unit === 'piece' ? 'pc' : 'kg';

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
      <div className="min-w-[220px] flex-1">
        <p className={cx('flex items-center gap-2 text-[13.5px] font-semibold', item.available ? 'text-ink' : 'text-faint line-through')}>
          {item.name}
          {item.isDemo && <Badge tone="amber">Demo</Badge>}
        </p>
        <p className="text-[12px] text-muted">
          {item.description ? `${item.description} · ` : ''}min {qty(item.minQty, item.unit)} · steps of {qty(item.qtyStep, item.unit)} · max {qty(item.maxQty, item.unit)}
        </p>
        {item.aliases.length > 0 && <p className="text-[11.5px] text-faint">Customers may say: {item.aliases.join(', ')}</p>}
        {err && <p className="mt-1 text-[12px] text-rose">{err}</p>}
      </div>
      {canEdit ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save({ price: Number(price), cutOptions: cuts.split(',').map((c) => c.trim()).filter(Boolean) });
          }}
        >
          <label className="flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-white px-2 text-[12.5px]" title="Cuts offered, comma separated">
            <Scissors className="size-3.5 text-muted" />
            <input value={cuts} onChange={(e) => setCuts(e.target.value)} placeholder="No cut choice" aria-label={`Cuts for ${item.name}`} className="w-[190px] bg-transparent text-ink outline-none placeholder:text-faint" />
          </label>
          <label className="flex h-9 items-center rounded-[10px] border border-line bg-white px-2 text-[13px]">
            <span className="text-muted">₹</span>
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              aria-label={`Price per ${per} of ${item.name}`}
              className="tabular w-14 bg-transparent px-1 text-right font-semibold text-ink outline-none"
            />
            <span className="text-muted">/{per}</span>
          </label>
          {dirty && (
            <Button type="submit" variant="primary" busy={busy} className="h-9">
              Save
            </Button>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] font-semibold text-muted">
            <input type="checkbox" checked={item.listed ?? item.available} disabled={busy} onChange={(e) => save({ available: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />
            Selling
          </label>
        </form>
      ) : (
        <p className="tabular text-[14px] font-bold text-ink">
          {inr(item.price)}/{per}
          {item.cutOptions.length > 0 && <span className="block text-[12px] font-normal text-muted">{item.cutOptions.join(', ')}</span>}
        </p>
      )}
      <StockCell item={item} canEdit={canEdit} onSaved={onSaved} />
    </li>
  );
}

const STOCK_BADGE: Record<string, { tone: 'brand' | 'amber' | 'rose' | 'slate'; label: string }> = {
  in_stock: { tone: 'brand', label: 'In stock' },
  low: { tone: 'amber', label: 'Low stock' },
  out: { tone: 'rose', label: 'Out of stock' },
  unknown: { tone: 'slate', label: 'Stock unknown' },
};

/**
 * Stock on hand (from the database) and its low-stock level. Staff set the counted quantity; orders take stock
 * when the customer confirms and give it back if the order is cancelled.
 */
function StockCell({ item, canEdit, onSaved }: { item: MenuItem; canEdit: boolean; onSaved: () => void }) {
  const unit = item.unit === 'piece' ? 'pcs' : 'kg';
  const [stock, setStock] = useState(item.stockQty == null ? '' : String(item.stockQty));
  const [low, setLow] = useState(item.lowStockThreshold == null ? '' : String(item.lowStockThreshold));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = stock !== (item.stockQty == null ? '' : String(item.stockQty)) || low !== (item.lowStockThreshold == null ? '' : String(item.lowStockThreshold));
  const badge = STOCK_BADGE[item.stockStatus ?? 'unknown'];

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/restaurant/inventory/${item.id}`, {
        stockQty: stock.trim() === '' ? null : Number(stock),
        lowStockThreshold: low.trim() === '' ? null : Number(low),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 border-t border-dashed border-line pt-2 text-[12.5px] md:w-auto md:border-0 md:pt-0">
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {item.stockIsDemo && item.stockQty != null && <Badge tone="amber">Demo stock</Badge>}
      {canEdit ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save();
          }}
        >
          <label className="flex h-9 items-center rounded-[10px] border border-line bg-white px-2" title="Stock on hand; empty = not tracked">
            <input inputMode="decimal" value={stock} onChange={(e) => setStock(e.target.value.replace(/[^\d.]/g, ''))} placeholder="—" aria-label={`Stock of ${item.name} in ${unit}`} className="tabular w-14 bg-transparent text-right font-semibold text-ink outline-none placeholder:text-faint" />
            <span className="ml-1 text-muted">{unit}</span>
          </label>
          <label className="flex h-9 items-center rounded-[10px] border border-line bg-white px-2" title="Alert when stock is at or below this">
            <span className="text-muted">low ≤</span>
            <input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value.replace(/[^\d.]/g, ''))} placeholder="—" aria-label={`Low-stock level of ${item.name}`} className="tabular w-10 bg-transparent text-right text-ink outline-none placeholder:text-faint" />
          </label>
          {dirty && (
            <Button type="submit" variant="primary" busy={busy} className="h-9">
              Save stock
            </Button>
          )}
        </form>
      ) : (
        <span className="tabular font-semibold text-ink">{item.stockQty == null ? '—' : `${item.stockQty} ${unit}`}</span>
      )}
      {err && <span className="text-rose">{err}</span>}
    </div>
  );
}

function AddProduct({ categories, onDone }: { categories: Catalog['categories']; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', price: '', unit: 'kg', categoryId: categories[0]?.id ?? '', cutOptions: 'Curry cut, Biryani cut, Whole', aliases: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
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
            await api.post('/restaurant/menu/items', {
              ...form,
              price: Number(form.price),
              cutOptions: form.cutOptions.split(',').map((c) => c.trim()).filter(Boolean),
              ...(form.unit === 'piece' ? { minQty: 1, qtyStep: 1, maxQty: 60 } : {}),
            });
            onDone();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input required placeholder="Product name" value={form.name} onChange={set('name')} className={input} aria-label="Product name" />
        <div className="flex gap-2">
          <input required inputMode="decimal" placeholder="Price (₹)" value={form.price} onChange={set('price')} className={cx(input, 'flex-1')} aria-label="Price" />
          <select value={form.unit} onChange={set('unit')} className={input} aria-label="Unit">
            <option value="kg">per kg</option>
            <option value="piece">per piece</option>
          </select>
        </div>
        <select value={form.categoryId} onChange={set('categoryId')} className={input} aria-label="Category">
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input placeholder="Cuts, comma separated (empty = no cut choice)" value={form.cutOptions} onChange={set('cutOptions')} className={cx(input, 'md:col-span-2')} aria-label="Cuts" />
        <input placeholder="Other names customers use" value={form.aliases} onChange={set('aliases')} className={input} aria-label="Other names" />
        <div className="flex items-center gap-2 md:col-span-3 md:justify-end">
          {err && <span className="text-[12.5px] text-rose">{err}</span>}
          <Button type="submit" variant="primary" busy={busy}>
            Add product
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** A menu category ("Chicken", "Eggs"...). Admins only; the server validates and keeps names unique. */
function AddCategory({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="flex flex-wrap items-start gap-2" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { await api.post('/restaurant/menu/categories', { name }); setName(''); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); }
    }}>
      <label className="sr-only" htmlFor="new-category">Category name</label>
      <input id="new-category" className="h-9 min-w-56 flex-1 rounded-[10px] border border-line px-3 text-[13px]" placeholder="Category name, e.g. Chicken" value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy} disabled={name.trim().length < 2}><Plus className="size-4" />Add category</Button>
      {err && <p role="alert" className="w-full text-[12.5px] text-rose">{err}</p>}
    </form>
  );
}

const OUTLET_EMPTY = { name: '', address: '', area: '', phone: '', opensAt: '07:00', closesAt: '21:00', prepMinutes: '30' };

/** A shop / pickup point (admins only; validated on the server). */
function AddOutletButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(OUTLET_EMPTY);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const field = (k: keyof typeof OUTLET_EMPTY, label: string, props: Record<string, unknown> = {}) => (
    <label className="grid gap-1 text-[12.5px] font-semibold text-ink">{label}
      <input className="h-9 rounded-[10px] border border-line px-3 text-[13px] font-normal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
      {errs[k] && <span className="font-normal text-rose">{errs[k]}</span>}
    </label>
  );
  if (!open) return <Button onClick={() => setOpen(true)}><Plus className="size-4" />Add shop</Button>;
  return (
    <form className="grid w-full gap-2 rounded-[12px] border border-line bg-white p-3 sm:w-[520px] sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null); setErrs({});
      try { await api.post('/restaurant/outlets', { ...f, prepMinutes: Number(f.prepMinutes) }); setF(OUTLET_EMPTY); setOpen(false); onDone(); }
      catch (x) { setErrs((x as { body?: { fields?: Record<string, string> } }).body?.fields ?? {}); setErr(x instanceof Error ? x.message : String(x)); }
      finally { setBusy(false); }
    }}>
      {field('name', 'Shop name')}
      {field('area', 'Area')}
      <div className="sm:col-span-2">{field('address', 'Address')}</div>
      {field('phone', 'Shop phone (optional)', { inputMode: 'tel' })}
      {field('prepMinutes', 'Minutes to cut and pack', { type: 'number', min: 0 })}
      {field('opensAt', 'Opens', { type: 'time' })}
      {field('closesAt', 'Closes', { type: 'time' })}
      {err && <p role="alert" className="text-[12.5px] text-rose sm:col-span-2">{err}</p>}
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={busy}>Save shop</Button><Button type="button" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}
