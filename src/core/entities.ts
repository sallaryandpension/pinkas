import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/open.ts';
import { appendAudit } from './audit.ts';
import { nowIso } from './util.ts';

export type BusinessProfile = {
  name: string;
  idNumber: string;          // ת"ז / מספר עוסק
  address: string;
  phone?: string;
  email?: string;
  status: 'exempt';          // עוסק פטור. מורשה/חברה – מחוץ להיקף כרגע.
};

export type Customer = {
  id: number;
  name: string;
  idNumber?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** שומר גרסה חדשה של פרטי העסק. מסמכים קיימים שומרים את הגרסה שהייתה בתוקף. */
export function setBusinessProfile(db: DatabaseSync, profile: BusinessProfile): void {
  if (!profile.name?.trim()) throw new Error('שם העסק חובה');
  if (!profile.idNumber?.trim()) throw new Error('מספר זהות / עוסק חובה (הוראה 5(א)(2))');
  if (!profile.address?.trim()) throw new Error('מען העסק חובה (הוראה 9(א)(1))');
  if (profile.status !== 'exempt') throw new Error('כרגע נתמך רק עוסק פטור');
  inTransaction(db, () => {
    db.prepare('INSERT INTO business_profile_versions (created_at, data) VALUES (?, ?)')
      .run(nowIso(), JSON.stringify(profile));
    appendAudit(db, 'business.profile', 'business', null, { name: profile.name });
  });
}

export function getBusinessProfile(db: DatabaseSync): BusinessProfile | null {
  const row = db.prepare('SELECT data FROM business_profile_versions ORDER BY id DESC LIMIT 1').get() as
    | { data: string } | undefined;
  return row ? (JSON.parse(row.data) as BusinessProfile) : null;
}

export function createCustomer(db: DatabaseSync, c: Omit<Customer, 'id'>): Customer {
  if (!c.name?.trim()) throw new Error('שם הלקוח חובה');
  return inTransaction(db, () => {
    const now = nowIso();
    const r = db.prepare(
      'INSERT INTO customers (name, id_number, address, email, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(c.name.trim(), c.idNumber ?? null, c.address ?? null, c.email ?? null, c.phone ?? null, now, now);
    const id = Number(r.lastInsertRowid);
    appendAudit(db, 'customer.create', 'customer', id, { name: c.name });
    return { id, ...c };
  });
}

export function updateCustomer(db: DatabaseSync, id: number, c: Omit<Customer, 'id'>): void {
  if (!c.name?.trim()) throw new Error('שם הלקוח חובה');
  inTransaction(db, () => {
    const r = db.prepare(
      'UPDATE customers SET name = ?, id_number = ?, address = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?',
    ).run(c.name.trim(), c.idNumber ?? null, c.address ?? null, c.email ?? null, c.phone ?? null, nowIso(), id);
    if (r.changes !== 1) throw new Error(`לקוח ${id} לא נמצא`);
    appendAudit(db, 'customer.update', 'customer', id, { name: c.name });
  });
}

export function getCustomer(db: DatabaseSync, id: number): Customer | null {
  const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  return r ? { id: r.id, name: r.name, idNumber: r.id_number, address: r.address, email: r.email, phone: r.phone } : null;
}
