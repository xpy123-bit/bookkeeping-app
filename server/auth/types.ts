/**
 * 可插拔登录渠道的接口定义。
 *
 * 设计要点：`capabilities` 把**协议层面的真相**编码进类型，而不是写在注释里。
 * 上层 UI 据此决定怎么呈现，避免出现「按钮点了才发现走不通」。
 */

/** 归一化后的身份。已剥离所有渠道专有字段与令牌。 */
export interface NormalizedIdentity {
  /** 渠道名，如 `alipay`。 */
  provider: string;
  /** 渠道内稳定标识。 */
  subject: string;
  /** `subject` 遵循的标识标准，见下方各实现说明。 */
  subjectStandard: string;
  /**
   * 显示名。
   *
   * **必须可空**：支付宝个人账号拿不到昵称（「获取会员信息」需企业认证）。
   * 若这里假设非空，支付宝用户会在首次登录时直接崩掉。
   */
  displayName: string | null;
  /** 头像地址。同样必须可空，且拿到后应当自行转存（外链会失效）。 */
  avatarUrl: string | null;
}

/** 渠道能力声明。 */
export interface ProviderCapabilities {
  /**
   * 是否支持 PKCE。
   *
   * 微信与支付宝**都没有文档化 PKCE**，因此两家都是 `false`。
   * 这意味着 `state` 是唯一的 CSRF 防线，不能省。
   */
  supportsPkce: boolean;
  /**
   * 能否在手机浏览器内完成授权。
   *
   * 支付宝的 H5 授权页**只能在支付宝客户端内打开**，在 Safari/Chrome 会报错，
   * 因此为 `false` —— 纯 Web 场景要引导用户用桌面端扫码。
   */
  worksInMobileBrowser: boolean;
  /** 生产环境能否拿到昵称。支付宝个人账号为 `false`。 */
  providesDisplayName: boolean;
  /** 生产环境能否拿到头像。支付宝个人账号为 `false`。 */
  providesAvatar: boolean;
}

/** 一个登录渠道。 */
export interface IdentityProvider {
  /** 渠道标识，用于 URL 与数据库。 */
  readonly key: string;
  /** 面向用户的中文名称。 */
  readonly displayName: string;
  /** 能力声明。 */
  readonly capabilities: ProviderCapabilities;
  /** 面向用户的说明，包括已知限制与所需资质。 */
  readonly note: string;
  /** 凭据是否齐备。缺凭据时不得尝试授权，必须明确报错而不是静默跳转。 */
  isConfigured(): boolean;
  /** 未配置时给用户的补救说明。 */
  configurationHint(): string;
  /**
   * 构造授权跳转地址。
   *
   * @param input.state 服务端生成的一次性 state。
   * @param input.redirectUri 回调地址，**必须是服务端常量**，不得由请求头推导。
   * @param input.codeChallenge PKCE 挑战值；渠道不支持时忽略。
   * @returns 完整的授权 URL。
   */
  buildAuthorizeUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }): string;
  /**
   * 用授权码换取归一化身份。
   *
   * 实现必须在此完成「换取令牌 → 取用户信息 → 归一化 → 丢弃令牌」，
   * **不得把渠道令牌持久化或返回给客户端**。微信官方明确要求
   * `access_token` 只保存在服务器。
   *
   * @param input.code 授权码。
   * @param input.redirectUri 与授权时一致的地址。
   * @param input.codeVerifier PKCE 校验值；渠道不支持时忽略。
   * @returns 归一化身份。
   * @throws {AuthExchangeError} 换取失败时。
   */
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<NormalizedIdentity>;
}

/** 换取身份失败。 */
export class AuthExchangeError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'AuthExchangeError';
    this.detail = detail;
  }
}
