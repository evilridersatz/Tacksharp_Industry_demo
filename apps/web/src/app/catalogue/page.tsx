'use client';

import { useCallback, useState } from 'react';
import { CheckCircle2, Package, Pencil, Plus, Search } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { TextileProduct } from '@/lib/types';
import { STOCK_STATUS, inr, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, ErrorBanner, Skeleton } from '@/components/ui';
import { Dialog, Label, Notice, TextileOnly, errorText, inputCls } from '@/components/textile';
import { useIndustry } from '@/lib/industry';

const UNITS = ['metre', 'piece', 'kg', 'set'];
const STOCK = ['in_stock', 'low', 'out_of_stock', 'unknown'];

export default function CataloguePage() {
  return (
    <>
      <PageHeader title="Product catalogue" crumb="Catalogue" />
      <TextileOnly allow={['textile', 'retail']}>
        <Catalogue />
      </TextileOnly>
    </>
  );
}

function Catalogue() {
  const { industry } = useIndustry();
  const retail = industry === 'retail';
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const { data, error, reload } = useApi<TextileProduct[]>(`/textile/products${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, 30_000);
  const [editing, setEditing] = useState<TextileProduct | 'new' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const rows = (data ?? []).filter((p) => showInactive || p.active);
  const unapproved = (data ?? []).filter((p) => p.active && !p.priceApproved).length;

  async function approve(p: TextileProduct) {
    try {
      await api.patch(`/textile/products/${p.id}`, { priceApproved: true });
      setNotice({ tone: 'ok', text: `Price approved for ${p.name}. The AI can now quote ${inr(p.price)}/${p.priceUnit}.` });
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted">
          The AI only describes products listed here and only states a price after you approve it. Unapproved prices are
          shown to customers as &quot;price on request&quot;.
          {unapproved > 0 && <b className="text-[#b45309]"> {unapproved} active product{unapproved > 1 ? 's' : ''} without an approved price.</b>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, SKU, colour…" aria-label="Search catalogue" className={`${inputCls} w-[240px] pl-9`} />
          </div>
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
            Show inactive
          </label>
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Add product
          </Button>
        </div>
      </div>
      <Notice notice={notice} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-[13px]">
          <thead className="border-b border-line text-left text-[12px] text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Product</th>
              <th className="px-3 py-3 font-medium">Specification</th>
              <th className="px-3 py-3 font-medium">MOQ</th>
              <th className="px-3 py-3 font-medium">Price</th>
              <th className="px-3 py-3 font-medium">Stock</th>
              <th className="px-3 py-3 font-medium">Updated</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!data && (
              <tr>
                <td colSpan={7} className="p-5">
                  <Skeleton className="h-24" />
                </td>
              </tr>
            )}
            {rows.map((p) => {
              const stock = STOCK_STATUS[p.stockStatus] ?? STOCK_STATUS.unknown;
              return (
                <tr key={p.id} className={`border-t border-line ${p.active ? '' : 'opacity-50'}`}>
                  <td className="px-5 py-2.5">
                    <p className="font-semibold text-ink">{p.name}</p>
                    <p className="text-[12px] text-muted">
                      {p.sku} · {p.fabricCategory}
                      {!p.active && ' · inactive'}
                    </p>
                  </td>
                  <td className="px-3 text-body">{(retail ? [p.composition, p.colour, p.sizes] : [p.composition, p.gsm ? `${p.gsm} GSM` : '', p.width, p.colour, p.design]).filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-3 text-body tabular">{p.moq ? `${p.moq} ${p.priceUnit}` : '—'}</td>
                  <td className="px-3">
                    {p.price !== null ? <span className="font-semibold text-ink tabular">{inr(p.price)}/{p.priceUnit}</span> : <span className="text-faint">No price</span>}
                    <div className="mt-0.5">{p.priceApproved ? <Badge tone="brand">Approved</Badge> : <Badge tone="amber">Not approved</Badge>}</div>
                  </td>
                  <td className="px-3">
                    <Badge tone={stock.tone}>{stock.label}</Badge>
                  </td>
                  <td className="px-3 text-muted">{timeAgo(p.updatedAt)}</td>
                  <td className="px-5 text-right whitespace-nowrap">
                    {!p.priceApproved && p.price !== null && (
                      <Button className="mr-2 h-8" onClick={() => approve(p)}>
                        <CheckCircle2 className="size-4" /> Approve price
                      </Button>
                    )}
                    <Button className="h-8" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                      <Pencil className="size-4" /> Edit
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && rows.length === 0 && (
          <Empty icon={<Package className="size-6" />} title={q ? 'No products match' : 'Your catalogue is empty'}>
            {q ? 'Try another name, SKU or colour.' : retail ? 'Add your products so the AI can answer enquiries from real data.' : 'Add your fabrics and products so the AI can answer enquiries from real data.'}
          </Empty>
        )}
      </Card>
      <Dialog open={editing !== null} onClose={close} title={editing === 'new' ? 'Add product' : 'Edit product'} wide>
        {editing !== null && (
          <ProductForm
            product={editing === 'new' ? null : editing}
            onSaved={async (msg) => {
              setEditing(null);
              setNotice({ tone: 'ok', text: msg });
              await reload();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function ProductForm({ product, onSaved }: { product: TextileProduct | null; onSaved: (msg: string) => void }) {
  const { industry } = useIndustry();
  const retail = industry === 'retail';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [approved, setApproved] = useState(product?.priceApproved ?? false);
  const [active, setActive] = useState(product?.active ?? true);

  async function submit(form: FormData) {
    setBusy(true);
    setErr(null);
    const str = (k: string) => String(form.get(k) ?? '').trim();
    const intOrNull = (k: string) => (str(k) === '' ? null : Number(str(k)));
    const body: Record<string, unknown> = {
      sku: str('sku'),
      name: str('name'),
      fabricCategory: str('fabricCategory'),
      composition: str('composition'),
      width: str('width'),
      colour: str('colour'),
      design: str('design'),
      sizes: str('sizes'),
      gsm: intOrNull('gsm'),
      moq: intOrNull('moq'),
      leadTimeDays: intOrNull('leadTimeDays'),
      priceUnit: str('priceUnit'),
      price: str('price') === '' ? null : Number(str('price')),
      priceApproved: approved,
      stockStatus: str('stockStatus'),
      catalogueUrl: str('catalogueUrl'),
      imageUrls: str('imageUrls').split(/\s+/).filter(Boolean),
      active,
    };
    try {
      const saved = product ? await api.patch<TextileProduct>(`/textile/products/${product.id}`, body) : await api.post<TextileProduct>('/textile/products', body);
      onSaved(saved.priceApproved || saved.price === null ? `${saved.name} saved.` : `${saved.name} saved. Its price is not approved yet, so the AI will say "price on request".`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(new FormData(e.currentTarget));
      }}
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
    >
      <Label text="SKU *"><input name="sku" required defaultValue={product?.sku} className={inputCls} placeholder="CT-POP-60" /></Label>
      <Label text="Name *" className="sm:col-span-2"><input name="name" required defaultValue={product?.name} className={inputCls} placeholder={retail ? 'Steel water bottle 1 L' : 'Cotton Poplin Shirting'} /></Label>
      <Label text={retail ? 'Category *' : 'Fabric / category *'}><input name="fabricCategory" required defaultValue={product?.fabricCategory} className={inputCls} placeholder={retail ? 'kitchen' : 'cotton shirting'} /></Label>
      <Label text={retail ? 'Material' : 'Composition'}><input name="composition" defaultValue={product?.composition ?? ''} className={inputCls} placeholder={retail ? 'stainless steel' : '100% cotton'} /></Label>
      {!retail && <Label text="GSM"><input name="gsm" type="number" min={0} defaultValue={product?.gsm ?? ''} className={inputCls} /></Label>}
      {!retail && <Label text="Width"><input name="width" defaultValue={product?.width ?? ''} className={inputCls} placeholder="58 inch" /></Label>}
      <Label text="Colour"><input name="colour" defaultValue={product?.colour ?? ''} className={inputCls} /></Label>
      {!retail && <Label text="Design"><input name="design" defaultValue={product?.design ?? ''} className={inputCls} /></Label>}
      <Label text={retail ? 'Sizes / variants' : 'Sizes'}><input name="sizes" defaultValue={product?.sizes ?? ''} className={inputCls} placeholder={retail ? 'S, M, L' : 'for garments'} /></Label>
      <Label text="MOQ"><input name="moq" type="number" min={0} defaultValue={product?.moq ?? ''} className={inputCls} /></Label>
      <Label text="Lead time (days)"><input name="leadTimeDays" type="number" min={0} defaultValue={product?.leadTimeDays ?? ''} className={inputCls} /></Label>
      <Label text="Price (₹)">
        <input
          name="price"
          type="number"
          min={0}
          step="0.01"
          defaultValue={product?.price ?? ''}
          // A new price is never approved by carry-over: editing it unticks approval until someone ticks it again.
          onChange={(e) => { if (Number(e.target.value) !== Number(product?.price ?? NaN)) setApproved(false); }}
          className={inputCls}
        />
      </Label>
      <Label text="Per">
        <select name="priceUnit" defaultValue={product?.priceUnit ?? (retail ? 'piece' : 'metre')} className={inputCls}>
          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </Label>
      <Label text="Stock">
        <select name="stockStatus" defaultValue={product?.stockStatus ?? 'unknown'} className={inputCls}>
          {STOCK.map((s) => <option key={s} value={s}>{STOCK_STATUS[s].label}</option>)}
        </select>
      </Label>
      <Label text="Catalogue / PDF link" className="sm:col-span-3"><input name="catalogueUrl" type="url" defaultValue={product?.catalogueUrl ?? ''} className={inputCls} placeholder="https://…" /></Label>
      <Label text="Image links (space separated)" className="sm:col-span-3"><input name="imageUrls" defaultValue={(product?.imageUrls ?? []).join(' ')} className={inputCls} placeholder="https://…/1.jpg https://…/2.jpg" /></Label>
      <label className="flex items-start gap-2.5 text-[13px] text-body sm:col-span-2">
        <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-brand)]" />
        <span>
          Price approved for the AI to quote
          <span className="block text-[12px] text-muted">Changing the price later withdraws the approval automatically.</span>
        </span>
      </label>
      <label className="flex items-start gap-2.5 text-[13px] text-body">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-brand)]" />
        Active
      </label>
      {err && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose sm:col-span-3">{err}</p>}
      <div className="flex justify-end gap-2 sm:col-span-3">
        <Button type="submit" variant="primary" busy={busy}>Save product</Button>
      </div>
    </form>
  );
}
