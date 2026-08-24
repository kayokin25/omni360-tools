/* Регрессия: строка-вторая-половина мёрджнутой 2-строчной шапки не должна
   считаться первой строкой данных (см. коммент в inventory-core.js —
   реальный кейс: «Efirnaia_spravka…» с mergeCell A11:A12…L11:L12, из-за
   чего первый настоящий экран получал номер 2 вместо 1). */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const I = require('./inventory-core.js');

const withMerge = '<mergeCells count="2"><mergeCell ref="A11:A12"/><mergeCell ref="B11:B12"/></mergeCells>';
assert.equal(I.mergedHeaderBottom(withMerge, 11), 12, 'должен раздвинуть шапку до нижней границы мёрджа');

const noMerge = '<mergeCells count="0"></mergeCells>';
assert.equal(I.mergedHeaderBottom(noMerge, 11), 11, 'без мёрджа — шапка это одна строка, как и раньше');

const noMergeAtAll = '<sheetData></sheetData>';
assert.equal(I.mergedHeaderBottom(noMergeAtAll, 11), 11, 'без блока <mergeCells> вовсе — тоже одна строка');

const unrelatedMerge = '<mergeCells count="1"><mergeCell ref="C20:C21"/></mergeCells>';
assert.equal(I.mergedHeaderBottom(unrelatedMerge, 11), 11, 'мёрдж не в шапке — не влияет на dataStart');

console.log('ok: mergedHeaderBottom');
