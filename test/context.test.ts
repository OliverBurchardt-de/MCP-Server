/**
 * Tests für Phase 1 des Mehrbenutzer-Umbaus: Anfrage-Kontext, Kanzlei-/
 * Nutzer-Bindung des Stores und serverseitige Mandanten-Autorisierung.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertClientAllowed,
  createLocalContextFactory,
  type RequestContext,
} from '../src/context/context.js';
import { buildCloudDataset } from '../src/datev/mapper.js';
import { datevStore } from '../src/store/memory.js';
import { getAccountBalance } from '../src/tools/balance.js';

const makeCtx = (
  principalId: string,
  organizationId: string,
  allowedClients?: string[]
): RequestContext => ({
  principalId,
  organizationId,
  requestId: `req-${principalId}`,
  ...(allowedClients ? { allowedClients: new Set(allowedClients) } : {}),
});

const makeDataset = (clientId: string, options: { partial?: boolean } = {}) =>
  buildCloudDataset(
    clientId,
    'Testmandant',
    20230101,
    { accountLength: 4 },
    [
      {
        accountNumber: 12000000,
        contraAccountNumber: 84000000,
        amountDebit: 100,
        date: '2023-01-01',
      },
    ],
    options.partial ? { truncated: true, totalCount: 9999 } : {}
  );

afterEach(() => {
  datevStore.clear();
});

describe('Kanzlei-Isolation (organizationId)', () => {
  it('eine fremde Kanzlei sieht und liest keine fremden Datensätze', () => {
    const kanzleiA = makeCtx('anna', 'kanzlei-a');
    const kanzleiB = makeCtx('bernd', 'kanzlei-b');
    datevStore.set(kanzleiA, makeDataset('455148-1'), '455148-1:20230101', {
      clientId: '455148-1',
    });

    // Liste der fremden Kanzlei ist leer — auch keine Schlüssel sichtbar.
    expect(datevStore.list(kanzleiB)).toHaveLength(0);
    // Ohne aktiven Datensatz: klarer "nichts geladen"-Fehler.
    expect(() => datevStore.get(kanzleiB)).toThrow(/Keine Daten geladen/);
    // Selbst mit erratenem exaktem Schlüssel: kein Zugriff, keine fremden
    // Schlüssel in der Fehlermeldung.
    expect(() => datevStore.get(kanzleiB, '455148-1:20230101')).toThrow(
      /Verfügbar: \(keiner\)/
    );
  });
});

describe('Nutzer-eigener aktiver Datensatz innerhalb der Kanzlei', () => {
  it('zwei Mitarbeitende verstellen sich den aktiven Datensatz nicht', () => {
    const anna = makeCtx('anna', 'kanzlei-a');
    const bernd = makeCtx('bernd', 'kanzlei-a');
    datevStore.set(anna, makeDataset('455148-1'), 'ds-anna');
    datevStore.set(bernd, makeDataset('455148-2'), 'ds-bernd');

    // Jeder behält den eigenen aktiven Datensatz. (clientNumber ist die
    // Mandantennummer hinter dem Bindestrich der clientId.)
    expect(datevStore.get(anna).header.clientNumber).toBe('1');
    expect(datevStore.get(bernd).header.clientNumber).toBe('2');

    // Kanzlei-weit sind beide sichtbar, aktiv ist je Nutzer der eigene.
    const listeAnna = datevStore.list(anna);
    expect(listeAnna).toHaveLength(2);
    expect(listeAnna.find((d) => d.key === 'ds-anna')?.active).toBe(true);
    expect(listeAnna.find((d) => d.key === 'ds-bernd')?.active).toBe(false);

    // Geteilte Daten: Bernd kann Annas Datensatz gezielt ansprechen.
    expect(datevStore.get(bernd, 'ds-anna').header.clientNumber).toBe('1');
  });
});

describe('Mandanten-Allowlist (serverseitige Autorisierung)', () => {
  it('assertClientAllowed lässt freigegebene Mandanten durch und blockt fremde', () => {
    const eingeschraenkt = makeCtx('carla', 'kanzlei-a', ['455148-1']);
    expect(() => assertClientAllowed(eingeschraenkt, '455148-1')).not.toThrow();
    expect(() => assertClientAllowed(eingeschraenkt, '455148-2')).toThrow(
      /nicht freigegeben/
    );
    // Ohne Allowlist gilt allein die DATEV-Berechtigung des Kontos.
    const offen = makeCtx('dora', 'kanzlei-a');
    expect(() => assertClientAllowed(offen, '455148-2')).not.toThrow();
  });

  it('der Store verbirgt Cloud-Datensätze nicht freigegebener Mandanten', () => {
    const lader = makeCtx('anna', 'kanzlei-a');
    datevStore.set(lader, makeDataset('455148-2'), '455148-2:20230101', {
      clientId: '455148-2',
    });

    const eingeschraenkt = makeCtx('carla', 'kanzlei-a', ['455148-1']);
    expect(datevStore.list(eingeschraenkt)).toHaveLength(0);
    expect(() => datevStore.get(eingeschraenkt, '455148-2:20230101')).toThrow(
      /Verfügbar: \(keiner\)/
    );

    // Datei-Datensätze (ohne clientId) bleiben kanzleiweit sichtbar.
    datevStore.set(lader, makeDataset('455148-2'), 'datei-export');
    expect(datevStore.list(eingeschraenkt).map((entry) => entry.key)).toEqual([
      'datei-export',
    ]);
  });
});

describe('Lokale Kontext-Fabrik', () => {
  it('liest Kanzlei, Nutzer und Allowlist aus der Umgebung', () => {
    const factory = createLocalContextFactory({
      DATEV_ORG_ID: 'kanzlei-burchardt',
      DATEV_PRINCIPAL_ID: 'ob',
      DATEV_ALLOWED_CLIENTS: '455148-1, 413885-2',
    } as NodeJS.ProcessEnv);
    const ctx = factory();
    expect(ctx.organizationId).toBe('kanzlei-burchardt');
    expect(ctx.principalId).toBe('ob');
    expect(ctx.allowedClients?.has('455148-1')).toBe(true);
    expect(ctx.allowedClients?.has('413885-2')).toBe(true);
    expect(ctx.allowedClients?.size).toBe(2);
    // Jede Anfrage bekommt eine eigene requestId.
    expect(factory().requestId).not.toBe(factory().requestId);
  });

  it('liefert ohne Umgebungsvariablen den Einzelplatz-Standard ohne Allowlist', () => {
    const ctx = createLocalContextFactory({} as NodeJS.ProcessEnv)();
    expect(ctx.organizationId).toBe('kanzlei-lokal');
    expect(ctx.principalId).toBe('lokaler-nutzer');
    expect(ctx.allowedClients).toBeUndefined();
  });
});

describe('Vollständigkeits-Warnung im Saldo (Lückenschluss P1-2)', () => {
  it('get_account_balance warnt bei unvollständigem Datensatz', () => {
    const ctx = makeCtx('anna', 'kanzlei-a');
    datevStore.set(ctx, makeDataset('455148-1', { partial: true }), 'partiell');

    const result = getAccountBalance(ctx, { account: '1200' });
    expect(String(result.datenstandWarnung)).toContain('UNVOLLSTÄNDIG');

    datevStore.set(ctx, makeDataset('455148-1'), 'vollstaendig');
    expect(
      getAccountBalance(ctx, { account: '1200' }).datenstandWarnung
    ).toBeUndefined();
  });
});
