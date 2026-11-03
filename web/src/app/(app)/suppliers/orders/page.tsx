'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, ExternalLink, Send, RefreshCw, Package, Plus, Trash2, Search } from 'lucide-react';
import { suppliersApi, inventoryApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';

interface OrderItem {
  name: string;
  unit?: string;
  suggested_qty?: number;
  qty_ordered?: number;
}

interface SupplierOrder {
  supplierId: string;
  supplierName: string;
  preferredChannel: string;
  isStandingOrder?: boolean;
  alreadyOrdered?: boolean;
  orderId?: string;
  status?: string;
  items: OrderItem[];
  contacts?: { phone?: string; email?: string; is_primary?: boolean }[];
}

interface Supplier { id: string; name: string; preferred_channel: string; }
interface NewItem  { _key: string; name: string; qty: string; unit: string; }
interface InvItem  { id: string; name: string; unit: string; current_qty: number; category_id?: string; category_name?: string; }

export default function DailyOrdersPage() {
  const { toast, confirm } = useAppDialog();
  const [suggestions, setSuggestions] = useState<SupplierOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, Record<string, number>>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, { channel: string; waLink?: string; to?: string; orderText?: string }>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  // מודל הזמנה ידנית
  const [showAddModal, setShowAddModal] = useState(false);
  const [allSuppliers, setAllSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [newItems, setNewItems] = useState<NewItem[]>([{ _key: crypto.randomUUID(), name: '', qty: '', unit: '' }]);
  const [addingOrder, setAddingOrder] = useState(false);
  // מאגר פריטים ממלאי
  const [invItems, setInvItems] = useState<InvItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [itemSearch, setItemSearch] = useState('');

  const loadSuggestions = () => {
    setLoadError(false);
    suppliersApi.dailyOrders().then(({ data }) => {
      const s = data.suggestions || data || [];
      setSuggestions(s);
      // Merge into (not replace) existing quantities — this reloads on every
      // 'order_sent' event from ANY supplier, so fully overwriting would wipe
      // manually-edited-but-not-yet-sent quantities for every other supplier
      // still on screen. Keep whatever the user already has for an item;
      // only fill in a default for items seen for the first time.
      setQuantities(prev => {
        const next: Record<string, Record<string, number>> = {};
        s.forEach((sup: SupplierOrder) => {
          next[sup.supplierId] = { ...prev[sup.supplierId] };
          sup.items.forEach(item => {
            if (next[sup.supplierId][item.name] === undefined) {
              next[sup.supplierId][item.name] = item.suggested_qty || item.qty_ordered || 0;
            }
          });
        });
        return next;
      });
      setLoading(false);
    }).catch(err => {
      setLoading(false);
      setLoadError(true);
      toast(getErrorMessage(err) || 'טעינת ההזמנות המוצעות נכשלה', 'error');
    });
  };

  useEffect(() => {
    loadSuggestions();
    suppliersApi.list().then(({ data }) => {
      const list: Supplier[] = Array.isArray(data) ? data : (data.items || []);
      setAllSuppliers(list.filter((s: Supplier & { is_active?: boolean }) => s.is_active !== false));
    });
    inventoryApi.list().then(({ data }) => {
      setInvItems(data.items || []);
    }).catch(() => {});
  }, []);
  // סטטוס הזמנה (נשלחה/אושרה/בוטלה/דולגה) משתנה גם מטאבים אחרים
  useSyncEvent('order_sent', loadSuggestions);

  const openAddModal = () => {
    setSelectedSupplierId(allSuppliers[0]?.id || '');
    setNewItems([{ _key: crypto.randomUUID(), name: '', qty: '', unit: '' }]);
    setSelectedCategory('all');
    setItemSearch('');
    setShowAddModal(true);
  };

  const addInvItemToOrder = (item: InvItem) => {
    if (newItems.find(i => i.name === item.name)) return;
    setNewItems(prev => [...prev.filter(i => i.name.trim()), { _key: crypto.randomUUID(), name: item.name, qty: '1', unit: item.unit || '' }]);
  };

  const categories = ['all', ...Array.from(new Set(invItems.map(i => i.category_name || 'ללא קטגוריה').filter(Boolean)))];
  const filteredInvItems = invItems.filter(item => {
    const catMatch = selectedCategory === 'all' || (item.category_name || 'ללא קטגוריה') === selectedCategory;
    const searchMatch = !itemSearch.trim() || item.name.toLowerCase().includes(itemSearch.toLowerCase());
    return catMatch && searchMatch;
  });

  const submitManualOrder = async () => {
    const sup = allSuppliers.find(s => s.id === selectedSupplierId);
    if (!sup) return;
    const items = newItems.filter(i => i.name.trim() && parseFloat(i.qty) > 0).map(i => ({
      name: i.name.trim(),
      qtyOrdered: parseFloat(i.qty),
      qtySuggested: null,
      unit: i.unit.trim(),
    }));
    if (!items.length) { toast('הוסף לפחות פריט אחד עם כמות'); return; }
    setAddingOrder(true);
    try {
      await suppliersApi.sendOrder(selectedSupplierId, {
        items,
        channel: sup.preferred_channel,
        noteToSupplier: '',
      });
      setShowAddModal(false);
      loadSuggestions();
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setAddingOrder(false);
    }
  };

  const setQty = (supplierId: string, itemName: string, qty: number) => {
    setQuantities(prev => ({
      ...prev,
      [supplierId]: { ...(prev[supplierId] || {}), [itemName]: qty },
    }));
  };

  const sendOrder = async (sup: SupplierOrder) => {
    const items = sup.items
      .map(item => ({
        name: item.name,
        qtyOrdered: quantities[sup.supplierId]?.[item.name] || 0,
        qtySuggested: item.suggested_qty,
        unit: item.unit || '',
      }))
      .filter(i => i.qtyOrdered > 0);

    if (!items.length) {
      toast('הכנס כמות לפחות לפריט אחד');
      return;
    }

    if (!await confirm(`לשלוח הזמנה ל-${sup.supplierName} (${items.length} פריטים)?`, 'שליחת הזמנה')) return;

    setSending(prev => ({ ...prev, [sup.supplierId]: true }));
    try {
      const { data } = await suppliersApi.sendOrder(sup.supplierId, {
        items,
        noteToSupplier: notes[sup.supplierId] || '',
        channel: sup.preferredChannel,
      });

      setResults(prev => ({ ...prev, [sup.supplierId]: data }));
      // WhatsApp isn't actually sent yet at this point — only a wa.me link was
      // generated; the order stays "pending" server-side until the user clicks
      // "פתח WhatsApp" (see confirmWhatsAppSent below). Email really was sent
      // by the backend already, so it's safe to mark it done immediately.
      if (data.channel !== 'whatsapp') {
        setSuggestions(prev =>
          prev.map(s => s.supplierId === sup.supplierId
            ? { ...s, alreadyOrdered: true, status: 'sent', orderId: data.orderId }
            : s
          )
        );
      } else {
        setSuggestions(prev =>
          prev.map(s => s.supplierId === sup.supplierId ? { ...s, orderId: data.orderId } : s)
        );
      }
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setSending(prev => ({ ...prev, [sup.supplierId]: false }));
    }
  };

  // נקרא כשהמשתמש לוחץ בפועל על "פתח WhatsApp" — זה האישור היחיד שיש לנו
  // שהוא בכלל ניגש לשלוח את ההודעה (אין דרך לאמת תוך כדי חלון WhatsApp עצמו)
  const confirmWhatsAppSent = (sup: SupplierOrder) => {
    if (!sup.orderId) return;
    suppliersApi.markOrderSent(sup.orderId).catch(() => {});
    setSuggestions(prev =>
      prev.map(s => s.supplierId === sup.supplierId ? { ...s, alreadyOrdered: true, status: 'sent' } : s)
    );
  };

  const channelLabel: Record<string, string> = {
    whatsapp: 'WhatsApp', email: 'אימייל', phone: 'טלפון', fax: 'פקס',
  };

  const channelVariant: Record<string, 'success' | 'info' | 'default'> = {
    whatsapp: 'success', email: 'info', phone: 'default', fax: 'default',
  };

  const pendingSuppliers = suggestions.filter(s => !s.alreadyOrdered);
  const doneSuppliers    = suggestions.filter(s => s.alreadyOrdered);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#e8e8e4' }}>הזמנות יומיות</h1>
          <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>
            {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { setLoading(true); loadSuggestions(); }}>
            <RefreshCw className="w-4 h-4" /> רענן
          </Button>
          <Button onClick={openAddModal}>
            <Plus className="w-4 h-4" /> הוסף הזמנה
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12" style={{ color: '#9aa0ab' }}>טוען...</div>
      ) : loadError ? (
        <div className="text-center py-16">
          <Package className="w-12 h-12 text-red-300 mx-auto mb-3" />
          <p style={{ color: '#ef4444' }}>טעינת ההזמנות המוצעות נכשלה — נסה לרענן</p>
        </div>
      ) : suggestions.length === 0 ? (
        <div className="text-center py-16">
          <Package className="w-12 h-12 text-gray-200 mx-auto mb-3" />
          <p style={{ color: '#9aa0ab' }}>אין ספקים פעילים</p>
        </div>
      ) : (
        <>
          {/* Pending orders */}
          {pendingSuppliers.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold uppercase" style={{ color: '#9aa0ab' }}>ממתינים להזמנה ({pendingSuppliers.length})</h2>
              {pendingSuppliers.map(sup => {
                const result = results[sup.supplierId];
                return (
                  <Card key={sup.supplierId}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <CardTitle>{sup.supplierName}</CardTitle>
                          <Badge variant={channelVariant[sup.preferredChannel] || 'default'}>
                            {channelLabel[sup.preferredChannel] || sup.preferredChannel}
                          </Badge>
                          {sup.isStandingOrder && <Badge variant="purple">הזמנה קבועה</Badge>}
                        </div>
                        {result?.waLink ? (
                          <a
                            href={result.waLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => confirmWhatsAppSent(sup)}
                            className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-500 text-white text-sm font-medium rounded-lg hover:bg-green-600 transition-colors"
                          >
                            <ExternalLink className="w-4 h-4" />
                            פתח WhatsApp
                          </a>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => sendOrder(sup)}
                            loading={sending[sup.supplierId]}
                          >
                            <Send className="w-4 h-4" />
                            {sup.preferredChannel === 'whatsapp' ? 'צור הזמנה' : 'שלח'}
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      {sup.items.length === 0 ? (
                        <p className="text-sm" style={{ color: '#9aa0ab' }}>אין פריטים מוצעים — הוסף ידנית</p>
                      ) : (
                        <div className="space-y-2">
                          {sup.items.map(item => (
                            <div key={item.name} className="flex items-center gap-3">
                              <span className="text-sm flex-1" style={{ color: '#e8e8e4' }}>{item.name}</span>
                              <span className="text-xs w-12 text-center" style={{ color: '#9aa0ab' }}>{item.unit || ''}</span>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => setQty(sup.supplierId, item.name, Math.max(0, (quantities[sup.supplierId]?.[item.name] || 0) - 1))}
                                  className="w-7 h-7 rounded-lg flex items-center justify-center text-lg"
                                  style={{ border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab', background: '#1a1a22' }}
                                >−</button>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.5}
                                  value={quantities[sup.supplierId]?.[item.name] || 0}
                                  onChange={e => setQty(sup.supplierId, item.name, parseFloat(e.target.value) || 0)}
                                  className="w-16 text-center rounded-lg py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                                  style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                                />
                                <button
                                  onClick={() => setQty(sup.supplierId, item.name, (quantities[sup.supplierId]?.[item.name] || 0) + 1)}
                                  className="w-7 h-7 rounded-lg flex items-center justify-center text-lg"
                                  style={{ border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab', background: '#1a1a22' }}
                                >+</button>
                              </div>
                              {item.suggested_qty && item.suggested_qty > 0 && (
                                <span className="text-xs text-blue-500 w-20">מוצע: {item.suggested_qty}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <input
                        value={notes[sup.supplierId] || ''}
                        onChange={e => setNotes(prev => ({ ...prev, [sup.supplierId]: e.target.value }))}
                        placeholder="הערה לספק (אופציונלי)"
                        className="mt-3 w-full text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                        style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                      />
                      {result?.waLink && (
                        <div className="mt-3 p-3 bg-green-50 rounded-lg">
                          <p className="text-xs text-green-700 font-medium mb-1">ההזמנה מוכנה — לחץ &quot;פתח WhatsApp&quot; לשליחה</p>
                          <p className="text-xs text-gray-500 font-mono whitespace-pre-wrap">{result.orderText as string}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Done orders */}
          {doneSuppliers.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold uppercase" style={{ color: '#9aa0ab' }}>הוזמן היום ({doneSuppliers.length})</h2>
              {doneSuppliers.map(sup => (
                <div key={sup.supplierId} className="flex items-center justify-between px-5 py-3 bg-green-50 border border-green-100 rounded-xl">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                    <span className="text-sm font-medium" style={{ color: '#e8e8e4' }}>{sup.supplierName}</span>
                  </div>
                  <Badge variant={sup.status === 'confirmed' ? 'success' : 'info'}>
                    {sup.status === 'confirmed' ? 'אושר' : 'נשלח'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {/* מודל הזמנה ידנית */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="הוסף הזמנה יומית" size="md">
        <div className="p-5 space-y-4" dir="rtl">
          {/* בחירת ספק */}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: '#b8bcc4' }}>ספק</label>
            <select
              value={selectedSupplierId}
              onChange={e => setSelectedSupplierId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
              style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
            >
              {allSuppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* בחירת פריטים ממאגר המלאי */}
          {invItems.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: '#b8bcc4' }}>בחר מהמלאי</label>
              {/* חיפוש */}
              <div className="relative mb-2">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  value={itemSearch}
                  onChange={e => setItemSearch(e.target.value)}
                  placeholder="חיפוש פריט..."
                  className="w-full pr-8 pl-3 py-1.5 text-xs rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                  style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                />
              </div>
              {/* קטגוריות */}
              <div className="flex gap-1.5 flex-wrap mb-2">
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                    style={selectedCategory === cat
                      ? { background: '#c9a227', color: '#0a0a0e' }
                      : { background: '#1a1a22', color: '#9aa0ab' }}
                  >
                    {cat === 'all' ? 'הכל' : cat}
                  </button>
                ))}
              </div>
              {/* פריטים */}
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1">
                {filteredInvItems.map(item => {
                  const already = newItems.some(i => i.name === item.name);
                  return (
                    <button
                      key={item.id}
                      onClick={() => addInvItemToOrder(item)}
                      disabled={already}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border transition-colors"
                      style={already
                        ? { background: 'rgba(22,163,74,0.12)', border: '1px solid rgba(22,163,74,0.3)', color: '#4ade80', cursor: 'default' }
                        : { background: '#1a1a22', border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab' }}
                    >
                      {already ? '✓' : <Plus className="w-2.5 h-2.5" />}
                      {item.name}
                      {item.unit ? <span style={{ color: '#9aa0ab' }}>{item.unit}</span> : null}
                    </button>
                  );
                })}
                {filteredInvItems.length === 0 && (
                  <p className="text-xs py-2" style={{ color: '#9aa0ab' }}>לא נמצאו פריטים</p>
                )}
              </div>
            </div>
          )}

          {/* פריטים שנבחרו */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#b8bcc4' }}>פריטים להזמנה</label>
            <div className="space-y-2">
              {newItems.map((item, idx) => (
                <div key={item._key} className="flex gap-2 items-center">
                  <input
                    placeholder="שם פריט"
                    value={item.name}
                    onChange={e => setNewItems(prev => prev.map((it, i) => i === idx ? { ...it, name: e.target.value } : it))}
                    className="flex-1 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                  />
                  <input
                    placeholder="כמות"
                    type="number"
                    min="0"
                    step="0.5"
                    value={item.qty}
                    onChange={e => setNewItems(prev => prev.map((it, i) => i === idx ? { ...it, qty: e.target.value } : it))}
                    className="w-20 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                  />
                  <input
                    placeholder="יחידה"
                    value={item.unit}
                    onChange={e => setNewItems(prev => prev.map((it, i) => i === idx ? { ...it, unit: e.target.value } : it))}
                    className="w-20 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                  />
                  {newItems.length > 1 && (
                    <button onClick={() => setNewItems(prev => prev.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600 p-1">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => setNewItems(prev => [...prev, { _key: crypto.randomUUID(), name: '', qty: '', unit: '' }])}
              className="mt-2 text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> הוסף שורה ידנית
            </button>
          </div>

          <div className="flex justify-end gap-3 pt-2" style={{ borderTop: '1px solid rgba(201,162,39,0.12)' }}>
            <Button variant="outline" onClick={() => setShowAddModal(false)}>ביטול</Button>
            <Button onClick={submitManualOrder} loading={addingOrder}>
              <Send className="w-4 h-4" /> שלח הזמנה
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
