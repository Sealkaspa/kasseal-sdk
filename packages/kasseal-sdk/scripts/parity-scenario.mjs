// Fixed, fake inputs for the byte-parity check: a curve buy, a curve sell, a pool buy, a pool sell, an add and a
// remove of liquidity, and a fee claim (curve and pool sweeps through the asynchronous builder), on every bundled
// build; and the first buy of a fresh curve by someone other than the creator (the creator window's sequence on the
// Kasseal-mainnet-3 builds, none on Kasseal-mainnet-2's). `B` is a module namespace (the published Node entry, or the in-repository sources). No network access.

export const SCENARIOS = Object.freeze(['curve first buy', 'curve buy', 'curve sell', 'pool buy', 'pool sell', 'add liquidity', 'remove liquidity', 'claim curve', 'claim pool']);
export const PARITY_NETWORKS = Object.freeze([['mainnet', 'v1-kasseal-mainnet-3'], ['mainnet', 'v1-kasseal-mainnet-2'], ['testnet-10', 'v1-kasseal-mainnet-3-tn10'], ['testnet-10', 'v1-kasseal-mainnet-2-tn10']]);

const KAS = 100_000_000n;
const SCALE = 1_000_000n;
const T = '22'.repeat(32);
const C = '33'.repeat(32);
const P = '55'.repeat(32);
const L = '66'.repeat(32);
const CREATOR = `000020${'5c'.repeat(32)}ac`;

export async function scenario(B) {
  const out = {};
  for (const [network, build] of PARITY_NETWORKS) {
    const k = B.sdk();
    const priv = new k.PrivateKey(`${'00'.repeat(31)}0b`);
    const address = priv.toAddress(network).toString();
    const xonly = B.fromHex(priv.toPublicKey().toXOnlyPublicKey().toString());
    const ctx = B.createContext('standard', network, 'v1', build);
    const p = ctx.curve.params;
    const outpoint = (seed, index = 0) => ({ txid: seed.toString(16).padStart(2, '0').repeat(32), index });
    const funding = (amount, seed) => ({ outpoint: outpoint(seed), amount, spk: B.p2pkScript(address), daaScore: 1n, address });
    const tokenCell = (cov, state, value, seed) => ({ kind: 'token', outpoint: outpoint(seed), value, covenantId: cov, program: B.tokenProgram(ctx.token, state), state, daaScore: 1n });
    const curveCell = (lotsSold, feeAccrued, value) => {
      const state = { tokenCovId: B.fromHex(T), lotsSold, feeAccrued, phase: B.PHASE_ACTIVE };
      return { kind: 'curve', outpoint: outpoint(0x33), value, covenantId: C, program: B.curveProgram(ctx.curve, state), state, daaScore: 1n };
    };
    const supply = (lotsSold) => tokenCell(T, B.covenantOwnedToken((p.curveLots - lotsSold) * p.lot, C), 10n * KAS, 0x21);
    const raise = (lots) => B.buyQuote(B.launchPresetOf(ctx.curve).curve, 0n, lots).cost;
    const rec = (name, shaped) => {
      const built = B.toBuilt(shaped);
      out[`${build} ${name}`] = { txid: built.txid, txJson: built.txJson };
    };

    // The first buy of a fresh curve, not funded by the creator (the preset's placeholder creator is not this key).
    rec('curve first buy', B.buildBuy({ proofVerdict: 'bound', ctx, curve: curveCell(0n, 0n, 5n * KAS), supply: supply(0n), buyer: { xOnlyPubkey: xonly, address }, n: 5n, funding: [funding(100n * KAS, 0x45)] }));

    // Curve buy and sell.
    rec('curve buy', B.buildBuy({ proofVerdict: 'bound', ctx, curve: curveCell(1_000n, 5_000n, 5n * KAS + raise(1_000n) + 5_000n), supply: supply(1_000n), buyer: { xOnlyPubkey: xonly, address }, n: 30n, funding: [funding(100n * KAS, 0x44)] }));
    const sold = 10_000n;
    rec('curve sell', B.buildSell({
      proofVerdict: 'bound', ctx, curve: curveCell(sold, 7_000n, 5n * KAS + raise(sold) + 7_000n), supply: supply(sold),
      userCell: tokenCell(T, B.userToken(3_000n * p.lot, xonly), 5n * KAS, 0x55), seller: { address }, n: 3_000n,
    }));

    // Pool swaps on the composable pool.
    const poolState = { tokenCovId: B.fromHex(T), kasScaled: 57_411_380n, tokenReserve: 400_400_000n, lpShares: B.LOCKED_SHARES, lpCovId: B.fromHex(L), feeAccruedScaled: 0n, creatorSpk: B.fromHex(CREATOR) };
    const pool = { kind: 'pool', outpoint: outpoint(0x96), value: poolState.kasScaled * SCALE, covenantId: P, program: B.poolProgram(ctx.pool, poolState), state: poolState, daaScore: 1n };
    const reserve = tokenCell(T, B.covenantOwnedToken(poolState.tokenReserve, P), 10n * KAS, 0x92);
    const buy = B.buildSwapKasForTokens({ ctx, pool, poolToken: reserve, buyer: { xOnlyPubkey: xonly, address }, kasInScaled: 1_000n, funding: [funding(100n * KAS, 0x93)] });
    rec('pool buy', buy);
    rec('pool sell', B.buildSwapTokensForKas({ ctx, pool, poolToken: reserve, userCell: tokenCell(T, buy.userNext, 5n * KAS, 0x94), seller: { address } }));

    // Liquidity on a bound pool.
    const standard = { tokenCovId: B.fromHex(T), kasScaled: 57_354_025n, tokenReserve: 400_000_000n, lpShares: B.LOCKED_SHARES, lpCovId: B.fromHex(L), feeAccruedScaled: 1_000n, creatorSpk: B.fromHex(CREATOR) };
    const after = { ...standard, kasScaled: 57_411_380n, tokenReserve: 400_400_000n, lpShares: 1_001_000n };
    const lpWorld = (state, seed) => ({
      ctx,
      pool: { kind: 'pool', outpoint: outpoint(seed), value: (state.kasScaled + state.feeAccruedScaled) * SCALE + 777n, covenantId: P, program: B.poolProgram(ctx.pool, state), state, daaScore: 1n },
      inventory: tokenCell(L, B.covenantOwnedToken(B.lpInventory({ kasScaled: state.kasScaled, tokenReserve: state.tokenReserve, feeAccruedScaled: state.feeAccruedScaled, dust: 0n, lpShares: state.lpShares }), P, B.fromHex(P)), 10n * KAS, seed + 1),
      reserve: tokenCell(T, B.covenantOwnedToken(state.tokenReserve, P), 10n * KAS, seed + 2),
    });
    rec('add liquidity', B.buildAddLiquidity({ ...lpWorld(standard, 0x80), userCell: tokenCell(T, B.userToken(400_000n, xonly), 5n * KAS, 0x83), funding: [funding(600n * KAS, 0x90)], changeAddress: address, shares: 1_000n, lpSafe: true }));
    rec('remove liquidity', B.buildRemoveLiquidity({ ...lpWorld(after, 0x70), userLpCell: tokenCell(L, B.userToken(1_000n, xonly, { extensionCommitment: B.fromHex(P) }), 5n * KAS, 0x84), changeAddress: address, shares: 1_000n }));

    // Fee claim: plan the creator's cells and build both sweeps through the asynchronous builder.
    const inst = B.instantiateCurve(ctx, B.fromHex(CREATOR));
    const Cc = '57'.repeat(32);
    const Pc = '58'.repeat(32);
    const curveFee = 2_234_567_891n;
    const curveState = { tokenCovId: B.fromHex(T), lotsSold: 100n, feeAccrued: curveFee, phase: B.PHASE_ACTIVE };
    const head = { outpoint: outpoint(0x85), amount: 2_000n * KAS + curveFee, covenantId: Cc, redeemScript: B.curveProgram(inst.curve, curveState), templateHash: inst.curve.templateHash, state: curveState, confirmed: true };
    const claimPool = { ...standard, lpShares: B.LOCKED_SHARES, lpCovId: new Uint8Array(32) };
    const poolHead = { outpoint: outpoint(0x86), amount: (claimPool.kasScaled + claimPool.feeAccruedScaled) * SCALE + 123_457n, covenantId: Pc, redeemScript: B.poolProgram(ctx.pool, claimPool), templateHash: ctx.pool.templateHash, state: claimPool, confirmed: true };
    const claimReserveState = B.covenantOwnedToken(claimPool.tokenReserve, Pc);
    const claimReserve = { outpoint: outpoint(0x87, 1), amount: 20n * KAS, covenantId: T, redeemScript: B.tokenProgram(ctx.token, claimReserveState), templateHash: ctx.token.templateHash, state: claimReserveState, confirmed: true };
    const no = async () => { throw new Error('not needed'); };
    const sources = {
      async funding() { return [funding(10n * KAS, 0x88)]; },
      async tokenCells(id, owner) { return id === T && owner === Pc ? [claimReserve] : []; },
      covenantCells: no,
      async curveHead(id) { if (id !== Cc) throw new Error('unknown curve'); return head; },
      async poolCell(id) { if (id !== Pc) throw new Error('unknown pool'); return poolHead; },
      async feerate() { return 100n; },
    };
    const builder = B.createTxBuilder({ networkId: network, sources, contexts: [inst] });
    const plan = B.planClaims([
      { tokenId: T, venue: 'curve', covenantId: Cc, contractSet: 'v1', accruedSompi: curveFee, creatorSpk: CREATOR },
      { tokenId: T, venue: 'pool', covenantId: Pc, contractSet: 'v1', accruedSompi: claimPool.feeAccruedScaled * SCALE + 123_457n, creatorSpk: CREATOR },
    ]);
    if (plan.plans.length !== 2) throw new Error(`claim plan: ${plan.plans.length} claims, expected 2`);
    const claims = await B.buildClaims((q) => builder.buildSweep(q), plan.plans, address);
    for (const c of claims.claims) out[`${build} claim ${c.plan.cell.venue}`] = { txid: c.tx.txid, txJson: c.tx.txJson };
  }
  return out;
}
