import { Contract, getAddress } from 'ethers'
import { AdaptersController } from '../../../../core/adaptersController'
import { Chain } from '../../../../core/constants/chains'
import { CacheToDb } from '../../../../core/decorators/cacheToDb'
import { Helpers } from '../../../../core/helpers'
import { CustomJsonRpcProvider } from '../../../../core/provider/CustomJsonRpcProvider'
import { logger } from '../../../../core/utils/logger'
import { IProtocolAdapter, ProtocolToken } from '../../../../types/IProtocolAdapter'
import {
  AdapterSettings,
  GetPositionsInput,
  PositionType,
  ProtocolAdapterParams,
  ProtocolDetails,
  ProtocolPosition,
  TokenType,
  Underlying,
  UnderlyingReward,
  UnwrapExchangeRate,
  UnwrapInput,
} from '../../../../types/adapter'
import { Protocol } from '../../../protocols'


type AdditionalMetadata = {
  operator?: string 
}

const HODLER_PROXY = getAddress('0x0d9a1ca7Bc756AE009672Db626CdE3c9BEF583EF')
const ANYONE_TOKEN = getAddress('0xFeAc2Eae96899709a43E252B6B92971D32F9C0F9')

const HODLER_ABI = [
  {
    inputs: [{ internalType: 'address', name: '_address', type: 'address' }],
    name: 'getStakes',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'operator', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
        ],
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export class AnyoneStakingAdapter implements IProtocolAdapter {
  productId = 'staking'
  protocolId: Protocol
  chainId: Chain
  helpers: Helpers

  adapterSettings: AdapterSettings = {
    includeInUnwrap: false,
    userEvent: false,
  }

  private provider: CustomJsonRpcProvider
  adaptersController: AdaptersController

  constructor({
    provider,
    chainId,
    protocolId,
    adaptersController,
    helpers,
  }: ProtocolAdapterParams) {
    this.provider = provider
    this.chainId = chainId
    this.protocolId = protocolId
    this.adaptersController = adaptersController
    this.helpers = helpers

    console.log(`--- DEBUG: AnyoneAdapter Initiated for Chain ${chainId} ---`)
    this.provider.getBlockNumber()
      .then((bn) => console.log(`--- DEBUG: CONNECTION SUCCESS! Current Block: ${bn} ---`))
      .catch((err) => console.error(`--- DEBUG: CONNECTION FAILED! Error: ${err.message} ---`))
  }

  getProtocolDetails(): ProtocolDetails {
    console.log('--- DEBUG: API is inspecting Anyone Adapter details ---')
    
    return {
      protocolId: this.protocolId,
      name: 'Anyone',
      description: 'Anyone Protocol staking position (HodlerV5)',
      siteUrl: 'https://anyone.io',
      iconUrl: 'https://docs.anyone.io/img/logo.png',
      positionType: PositionType.Supply,
      chainId: this.chainId,
      productId: this.productId,
    }
  }
  
  @CacheToDb
  async getProtocolTokens(): Promise<ProtocolToken<AdditionalMetadata>[]> {
    console.log('--- DEBUG: CACHE BYPASSED - RETURNING TOKENS ---');
    
    return [
      {
        address: HODLER_PROXY,
        name: 'Staked ANYONE',
        symbol: 'stANYONE',
        decimals: 18,
        underlyingTokens: [
          {
            address: ANYONE_TOKEN,
            name: 'Anyone',
            symbol: 'ANYONE',
            decimals: 18,
          },
        ],
      },
    ]
  }

  private async getProtocolTokenByAddress(protocolTokenAddress: string) {
    return this.helpers.getProtocolTokenByAddress({
      protocolTokens: await this.getProtocolTokens(),
      protocolTokenAddress,
    })
  }

  async getPositions(input: GetPositionsInput): Promise<ProtocolPosition[]> {
    return this.getPositionsLogic(input)
  }

  // Moved logic here to keep class clean
  async getPositionsLogic(input: GetPositionsInput): Promise<ProtocolPosition[]> {
    const userRaw = (input as any).userAddress ?? (input as any).address
    const userAddress = getAddress(userRaw)
    
    // DEBUG LOG
    console.log(`--- DEBUG: Checking Positions for ${userAddress} ---`);

    const hodler: any = new Contract(HODLER_PROXY, HODLER_ABI, this.provider)
    const stakesRaw = await hodler.getStakes(userAddress)

    if (!stakesRaw?.length) return []

    const protocolToken = await this.getProtocolTokenByAddress(HODLER_PROXY)

    const normalized = stakesRaw
      .map((s: any) => {
        const operator = s?.operator ?? s?.[0]
        const rawAmt = s?.amount ?? s?.[1]
        if (!operator || rawAmt == null) return null
        const amt = typeof rawAmt === 'bigint' ? rawAmt : BigInt(rawAmt.toString())
        return amt > 0n ? { operator: getAddress(String(operator)), amount: amt } : null
      })
      .filter(Boolean)

    return normalized.map((item: any) => {
      const amountStr = item.amount.toString()
      return {
        id: `${protocolToken.address}:${item.operator}`,
        type: TokenType.Protocol,
        protocolId: this.protocolId,
        productId: this.productId,
        chainId: this.chainId,
        address: protocolToken.address,
        balanceRaw: amountStr,
        tokens: [{ ...protocolToken, balanceRaw: amountStr }],
        underlying: (protocolToken.underlyingTokens || []).map((t: any) => ({
          type: 'underlying',
          balanceRaw: amountStr,
          ...t,
        })),
        metadata: { operator: item.operator },
      }
    }) as any
  }

  async unwrap({ protocolTokenAddress }: UnwrapInput): Promise<UnwrapExchangeRate> {
    const protocolToken = await this.getProtocolTokenByAddress(protocolTokenAddress)
    return this.helpers.unwrapOneToOne({
      protocolToken,
      underlyingTokens: protocolToken.underlyingTokens,
    })
  }
}