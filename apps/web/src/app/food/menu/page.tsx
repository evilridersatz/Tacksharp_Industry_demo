'use client';

import { useCallback, useState } from 'react';
import { Pencil } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { Pill, SearchBox, SourceNote, Stat, Toolbar, money } from '@/components/vertical-ui';

type Priced = { name: string; price: number };
type Item = { id: string; name: string; category: string; description: string | null; price: number; variants: Priced[]; addOns: Priced[]; available: boolean; soldOut: boolean; stockQty: number | null; isVeg: boolean | null; taxRatePct: number | null };
type Menu = {
  categories: Array<{ name: string; items: Item[] }>;
  outlets: Array<{ id: string; name: string; address: string; opensAt: string; closesAt: string; prepMinutes: number; open: boolean }>;
  config: { taxPct: number; packagingFee: number; pickupEnabled: boolean; deliveryEnabled: boolean; deliveryZones: Array<{ name: string; fee: number; minOrder: number; etaMinutes: number }> };
};

export default function FoodMenuPage() {
  return (
    <>
      <PageHeader title="Menu & availability" crumb="Menu" />
      <IndustryOnly allow={['food']}>
        <MenuView />
      </IndustryOnly>
    </>
  );
}

function MenuView() {
  const { data, error, reload } = useApi<Menu>('/food/menu', 30_000);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = useCallback(() => setEditing(null), []);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const items = data.categories.flatMap((c) => c.items);
  async function toggle(i: Item) {
    setBusy(i.id);
    try {
      await api.patch(`/food/menu/${i.id}`, { available: !i.available });
      setNotice({ tone: 'ok', text: `${i.name} is now ${i.available ? 'unavailable (the assistant will offer alternatives)' : 'available'}.` });
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  const s = q.trim().toLowerCase();
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Menu items" value={items.length} hint={`${data.categories.length} categories`} />
        <Stat label="Sold out / unavailable" value={items.filter((i) => i.soldOut).length} tone={items.some((i) => i.soldOut) ? 'amber' : undefined} />
        <Stat label="Tax & packing" value={`${data.config.taxPct}%`} hint={`Packing ${money(data.config.packagingFee)} per order`} />
        <Stat label="Delivery zones" value={data.config.deliveryEnabled ? data.config.deliveryZones.length : 'Pickup only'} hint={data.config.deliveryZones.map((z) => z.name).join(', ')} />
      </div>
      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {data.outlets.map((o) => (
          <Card key={o.id} className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="font-semibold text-ink">{o.name}</p>
              <p className="text-[12.5px] text-muted">{o.address}</p>
              <p className="mt-1 text-[12px] text-body">Open {o.opensAt}–{o.closesAt} · ready in ~{o.prepMinutes} min</p>
            </div>
            <Pill status={o.open ? 'available' : 'closed'} tone={o.open ? 'green' : 'slate'}>{o.open ? 'open now' : 'closed'}</Pill>
          </Card>
        ))}
        {data.config.deliveryEnabled && (
          <Card className="p-4 lg:col-span-2">
            <p className="mb-2 text-[13px] font-semibold text-ink">Delivery zones</p>
            <div className="flex flex-wrap gap-2">
              {data.config.deliveryZones.map((z) => <span key={z.name} className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-body">{z.name} · {money(z.fee)} · min {money(z.minOrder)} · ~{z.etaMinutes} min</span>)}
            </div>
            <p className="mt-2 text-[11.5px] text-faint">Edit zones, tax and packing in Settings.</p>
          </Card>
        )}
      </div>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Search the menu" />
      </Toolbar>
      {data.categories.map((c) => {
        const list = c.items.filter((i) => !s || i.name.toLowerCase().includes(s));
        if (!list.length) return null;
        return (
          <section key={c.name} className="mb-5">
            <h2 className="mb-2 text-[15px] font-bold text-ink">{c.name} <span className="text-[12px] font-normal text-muted">· {list.length}</span></h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((i) => (
                <li key={i.id}>
                  <Card className={cx('flex h-full flex-col p-4', i.soldOut && 'bg-slate-50/70')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 font-semibold text-ink">
                          {i.isVeg !== null && <span className={cx('grid size-3.5 place-items-center rounded-[3px] border', i.isVeg ? 'border-emerald-600' : 'border-rose-600')} aria-label={i.isVeg ? 'Vegetarian' : 'Non-vegetarian'}><span className={cx('size-1.5 rounded-full', i.isVeg ? 'bg-emerald-600' : 'bg-rose-600')} /></span>}
                          <span className="truncate">{i.name}</span>
                        </p>
                        <p className="mt-0.5 text-[13px] font-semibold text-body">{i.variants.length ? i.variants.map((v) => `${v.name} ${money(v.price)}`).join(' · ') : money(i.price)}</p>
                      </div>
                      {i.soldOut ? <Pill tone="red">{i.available ? 'sold out' : 'unavailable'}</Pill> : <Pill tone="green">available</Pill>}
                    </div>
                    {i.addOns.length > 0 && <p className="mt-1.5 text-[12px] text-muted">Add-ons: {i.addOns.map((a) => `${a.name} +${money(a.price)}`).join(', ')}</p>}
                    <p className="mt-1 text-[11.5px] text-faint">{i.stockQty !== null ? `Stock: ${i.stockQty}` : 'Stock not tracked'}{i.taxRatePct !== null ? ` · tax ${i.taxRatePct}%` : ''}</p>
                    <div className="mt-auto flex gap-2 pt-3">
                      <Button className="flex-1" busy={busy === i.id} onClick={() => toggle(i)}>{i.available ? 'Mark unavailable' : 'Make available'}</Button>
                      <Button aria-label={`Edit ${i.name}`} onClick={() => setEditing(i)}><Pencil className="size-4" /></Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <SourceNote api="GET /food/menu · PATCH /food/menu/:id" />
      <Dialog open={!!editing} onClose={close} title={editing ? `Edit ${editing.name}` : 'Edit'}>
        {editing && <EditItem item={editing} onDone={async (t) => { setEditing(null); setNotice({ tone: 'ok', text: t }); await reload(); }} />}
      </Dialog>
    </>
  );
}

function EditItem({ item, onDone }: { item: Item; onDone: (text: string) => void }) {
  const [price, setPrice] = useState(String(item.price));
  const [stock, setStock] = useState(item.stockQty === null ? '' : String(item.stockQty));
  const [variants, setVariants] = useState(item.variants.map((v) => `${v.name}:${v.price}`).join(', '));
  const [addOns, setAddOns] = useState(item.addOns.map((v) => `${v.name}:${v.price}`).join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parse = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ name: x.split(':')[0].trim(), price: Number(x.split(':')[1]) }));
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/food/menu/${item.id}`, { price: Number(price), stockQty: stock === '' ? null : Number(stock), variants: parse(variants), addOns: parse(addOns) });
      onDone(`${item.name} updated. The assistant uses the new price from the next message.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Label text="Base price (₹)"><input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} className={inputCls} /></Label>
        <Label text="Stock (blank = not tracked)"><input type="number" min={0} value={stock} onChange={(e) => setStock(e.target.value)} className={inputCls} /></Label>
      </div>
      <Label text="Sizes / portions (name:price, comma separated)"><input value={variants} onChange={(e) => setVariants(e.target.value)} placeholder="Half:179, Full:249" className={inputCls} /></Label>
      <Label text="Add-ons (name:price, comma separated)"><input value={addOns} onChange={(e) => setAddOns(e.target.value)} placeholder="Extra Raita:20" className={inputCls} /></Label>
      <p className="text-[11.5px] text-muted">When sizes are set, the chosen size's price is charged; add-ons are added per item. Prices are validated on the server.</p>
      <div className="flex justify-end"><Button variant="primary" busy={busy} onClick={save}>Save</Button></div>
    </div>
  );
}
