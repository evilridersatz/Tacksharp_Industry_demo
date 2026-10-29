import { describe, expect, it } from 'vitest';
import { maskPatientData } from './verticals.controller.js';
import { can } from '../governance/permissions.js';

const appt = { id: 'a1', reasonNote: 'chest pain', patient: { name: 'Ravi', phone: '919840012345' }, items: [{ patientPhone: '919000011111' }] };

describe('healthcare privacy', () => {
  it('front desk, insurance desk and admins see patient details in full', () => {
    for (const role of ['admin', 'manager', 'reception', 'insurance', 'operator']) expect(maskPatientData(appt, role)).toEqual(appt);
  });
  it('read-only viewers see masked phones and no visit reason', () => {
    const m = maskPatientData(appt, 'viewer');
    expect(m.patient.phone).toBe('••••2345');
    expect(m.items[0].patientPhone).toBe('••••1111');
    expect(m.reasonNote).toMatch(/hidden/);
    expect(m.patient.name).toBe('Ravi');
  });
  it('roles outside healthcare cannot read patients at all', () => {
    for (const role of ['finance', 'marketing', 'technician', 'sales', 'front_desk']) expect(can(role, 'clinic.view')).toBe(false);
  });
});
