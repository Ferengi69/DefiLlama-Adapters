const ADDRESSES = require('../helper/coreAssets.json')
const { getLogs } = require('../helper/cache/getLogs')
const { sumTokens2 } = require('../helper/unwrapLPs')

// Uniswap V3 fork; pools are CREATE2'd by a separate pool deployer but PoolCreated is emitted by the factory
const FACTORY = '0x221A6239E40709792b0d4bdc140fA36158CD41C7'
const FACTORY_BLOCK = 73266708
const LAUNCHPAD = '0xb4883BD311F837Fb68086a0e41C9B7917feb631e'
const LAUNCHPAD_BLOCK = 76415695
const GOO = '0x6572EADe9Fb17F4027baF92FEAC222B9AA746bd0'.toLowerCase()
const WETH = ADDRESSES.robinhood.WETH.toLowerCase()

// GOO has no external price, so it is valued in WETH at its GOO/WETH pool price, and at most this many
// times the WETH in that pool is counted (like restrictTokenRatio in transformDexBalances, but measured in WETH)
const RESTRICT_TOKEN_RATIO = 5n
const Q192 = 2n ** 192n

const poolCreatedAbi = 'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
const launchedAbi = 'event Launched(address indexed token, address indexed pool, address indexed creator, address feeRecipient, string name, string symbol, string metadata, uint256 creatorBuy, uint256 tokensBought)'
const slot0Abi = 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'

const eq = (a, b) => a.toLowerCase() === b.toLowerCase()

async function getLaunchPools(api) {
  await api.getBlock()
  if (api.block < LAUNCHPAD_BLOCK) return new Set()
  const launches = await getLogs({ api, target: LAUNCHPAD, fromBlock: LAUNCHPAD_BLOCK, eventAbi: launchedAbi, onlyArgs: true })
  return new Set(launches.map(i => i.pool.toLowerCase()))
}

// replaces the GOO balance with its WETH value, priced by the GOO/WETH pool that holds the most WETH
async function addGooAsWeth(api, pools) {
  const gooWethPools = pools.filter(p => (eq(p.token0, GOO) && eq(p.token1, WETH)) || (eq(p.token0, WETH) && eq(p.token1, GOO)))
  if (!gooWethPools.length) return

  const wethBals = await api.multiCall({ abi: 'erc20:balanceOf', target: WETH, calls: gooWethPools.map(p => p.pool) })
  let best = 0
  wethBals.forEach((bal, i) => { if (BigInt(bal) > BigInt(wethBals[best])) best = i })
  const { sqrtPriceX96 } = await api.call({ abi: slot0Abi, target: gooWethPools[best].pool })
  const priceSq = BigInt(sqrtPriceX96) ** 2n
  const wethDepth = BigInt(wethBals[best])
  if (!priceSq || !wethDepth) return

  const gooKey = `${api.chain}:${GOO}`
  const goo = BigInt(api.getBalances()[gooKey] ?? 0)
  if (!goo) return

  // sqrtPriceX96^2 / 2^192 is token1 per token0; both tokens have 18 decimals
  const wethForGoo = eq(gooWethPools[best].token0, GOO) ? goo * priceSq / Q192 : goo * Q192 / priceSq
  const cap = wethDepth * RESTRICT_TOKEN_RATIO
  api.removeTokenBalance(GOO)
  if (wethForGoo <= cap) return api.add(WETH, wethForGoo.toString())
  // GOO beyond the cap stays unpriced
  api.add(WETH, cap.toString())
  api.add(GOO, (goo - goo * cap / wethForGoo).toString())
}

async function tvl(api) {
  const pools = await getLogs({ api, target: FACTORY, fromBlock: FACTORY_BLOCK, eventAbi: poolCreatedAbi, onlyArgs: true })
  const launchPools = await getLaunchPools(api)
  // a launch pool's other side is mostly the launch token's unsold supply, not deposited value
  const ownerTokens = pools.map(p => [launchPools.has(p.pool.toLowerCase()) ? [GOO] : [p.token0, p.token1], p.pool])
  await sumTokens2({ api, ownerTokens, permitFailure: pools.length > 2000 })
  await addGooAsWeth(api, pools)
}

module.exports = {
  misrepresentedTokens: true,
  start: '2026-09-26',
  methodology: 'Counts the tokens held by every pool created by the goo exchange factory on Robinhood Chain, found from its PoolCreated events. GOO, the protocol token, has no external price, so it is valued in WETH at the price of its deepest GOO/WETH pool, counting at most 5 times the WETH in that pool. Launch pools of the goo exchange launchpad count only their GOO: the launch token side is mostly unsold supply.',
  robinhood: { tvl },
}
