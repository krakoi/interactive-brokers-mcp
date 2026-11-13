import z from "zod";

const IntegerOrStringIntegerZod = z.union([
  z.number().positive(),
  z.string().regex(/^[0-9]+(\.[0-9]+)?$/).transform((val) => parseFloat(val))
]);

const SecurityTypeZod = z.enum(["STK", "OPT"]);
const OptionRightZod = z.enum(["C", "P"]);

export const AuthenticateZodShape = {
  confirm: z.literal(true)
};

export const GetAccountInfoZodShape = {
  confirm: z.literal(true)
};

export const GetPositionsZodShape = {
  accountId: z.string()
};

export const GetPortfolioSnapshotZodShape = {
  accountIds: z.array(z.string()).optional()
};

export const GetFxRatesZodShape = {
  accountIds: z.array(z.string()).optional(),
  quoteCurrencies: z.array(z.string().regex(/^[A-Za-z]{3}$/)).optional()
};

export const GetOptionChainZodShape = {
  symbol: z.string(),
  exchange: z.string().optional()
};

export const ResolveOptionConidZodShape = {
  symbol: z.string(),
  expiry: z.string(),
  strike: IntegerOrStringIntegerZod,
  right: OptionRightZod,
  exchange: z.string().optional()
};

export const GetMarketDataZodShape = {
  symbol: z.string(),
  exchange: z.string().optional()
};

export const PlaceOrderZodShape = {
  accountId: z.string(),
  symbol: z.string().optional(),
  conid: IntegerOrStringIntegerZod.optional(),
  secType: SecurityTypeZod.optional(),
  expiry: z.string().optional(),
  strike: IntegerOrStringIntegerZod.optional(),
  right: OptionRightZod.optional(),
  action: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MKT", "LMT", "STP"]),
  quantity: IntegerOrStringIntegerZod,
  price: z.number().optional(),
  stopPrice: z.number().optional(),
  suppressConfirmations: z.boolean().optional(),
  exchange: z.string().optional(),
  tif: z.enum(["DAY", "GTC", "IOC", "OPG"]).optional()
};

export const GetOrderStatusZodShape = {
  orderId: z.string()
};

export const GetLiveOrdersZodShape = {
  accountId: z.string().optional()
};

export const ConfirmOrderZodShape = {
  replyId: z.string(),
  messageIds: z.array(z.string())
};

export const GetAlertsZodShape = {
  accountId: z.string()
};

export const CreateAlertZodShape = {
  accountId: z.string(),
  alertRequest: z.object({
    orderId: z.number().optional(),
    alertName: z.string(),
    alertMessage: z.string().optional(),
    alertRepeatable: z.number().optional(),
    expireTime: z.string().optional(),
    outsideRth: z.number().optional(),
    iTWSOrdersOnly: z.number().optional(),
    showPopup: z.number().optional(),
    toolId: z.number().optional(),
    playAudio: z.string().optional(),
    emailNotification: z.string().optional(),
    sendMessage: z.number().optional(),
    tif: z.string().optional(),
    logicBind: z.string().optional(),
    conditions: z.array(
      z.object({
        conidex: z.string(),
        type: z.string(),
        operator: z.string(),
        triggerMethod: z.string(),
        value: z.string(),
        logicBind: z.string().optional(),
        timeZone: z.string().optional()
      })
    )
  })
};

export const ActivateAlertZodShape = {
  accountId: z.string(),
  alertId: z.string()
};

export const DeleteAlertZodShape = {
  accountId: z.string(),
  alertId: z.string()
};

export const GetFlexQueryZodShape = {
  queryId: z.string(),
  queryName: z.string().optional(),
  parseXml: z.boolean().optional().default(true),
  saveTo: z.string().optional()
    .describe("Absolute path to write the raw Flex statement XML to (e.g. for importing into Portfolio Performance). Fails if the file already exists. Returns a summary instead of the data."),
  fromDate: z.string().regex(/^\d{8}$/, "fromDate must be YYYYMMDD").optional()
    .describe("Start of a custom date range, YYYYMMDD. Must be given together with toDate. Overrides the query's configured period."),
  toDate: z.string().regex(/^\d{8}$/, "toDate must be YYYYMMDD").optional()
    .describe("End of a custom date range, YYYYMMDD (inclusive). Must be given together with fromDate."),
};

export const ListFlexQueriesZodShape = {
  confirm: z.literal(true)
};

export const ForgetFlexQueryZodShape = {
  queryId: z.string()
};

const AuthenticateZodSchema = z.object(AuthenticateZodShape);
const GetAccountInfoZodSchema = z.object(GetAccountInfoZodShape);
export const GetPositionsZodSchema = z.object(GetPositionsZodShape);
export const GetPortfolioSnapshotZodSchema = z.object(GetPortfolioSnapshotZodShape);
export const GetFxRatesZodSchema = z.object(GetFxRatesZodShape);
export const GetOptionChainZodSchema = z.object(GetOptionChainZodShape);
export const ResolveOptionConidZodSchema = z.object(ResolveOptionConidZodShape);
export const GetMarketDataZodSchema = z.object(GetMarketDataZodShape);

export const PlaceOrderZodSchema = z
  .object(PlaceOrderZodShape)
  .superRefine((data, ctx) => {
    if (data.orderType === "LMT" && data.price === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LMT orders require price",
        path: ["price"]
      });
    }

    if (data.orderType === "STP" && data.stopPrice === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "STP orders require stopPrice",
        path: ["stopPrice"]
      });
    }

    if (!data.symbol && data.conid === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either symbol or conid is required",
        path: ["symbol"]
      });
    }

    if (data.secType === "OPT" && data.conid === undefined) {
      if (!data.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPT orders without conid require symbol",
          path: ["symbol"]
        });
      }
      if (!data.expiry) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPT orders without conid require expiry",
          path: ["expiry"]
        });
      }
      if (data.strike === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPT orders without conid require strike",
          path: ["strike"]
        });
      }
      if (!data.right) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPT orders without conid require right",
          path: ["right"]
        });
      }
    }
  });

export const GetOrderStatusZodSchema = z.object(GetOrderStatusZodShape);
export const GetLiveOrdersZodSchema = z.object(GetLiveOrdersZodShape);
export const ConfirmOrderZodSchema = z.object(ConfirmOrderZodShape);
export const GetAlertsZodSchema = z.object(GetAlertsZodShape);
export const CreateAlertZodSchema = z.object(CreateAlertZodShape);
export const ActivateAlertZodSchema = z.object(ActivateAlertZodShape);
export const DeleteAlertZodSchema = z.object(DeleteAlertZodShape);
export const GetFlexQueryZodSchema = z.object(GetFlexQueryZodShape);
export const ListFlexQueriesZodSchema = z.object(ListFlexQueriesZodShape);
export const ForgetFlexQueryZodSchema = z.object(ForgetFlexQueryZodShape);

export type AuthenticateInput = z.infer<typeof AuthenticateZodSchema>;
export type GetAccountInfoInput = z.infer<typeof GetAccountInfoZodSchema>;
export type GetPositionsInput = z.infer<typeof GetPositionsZodSchema>;
export type GetPortfolioSnapshotInput = z.infer<typeof GetPortfolioSnapshotZodSchema>;
export type GetFxRatesInput = z.infer<typeof GetFxRatesZodSchema>;
export type GetOptionChainInput = z.infer<typeof GetOptionChainZodSchema>;
export type ResolveOptionConidInput = z.infer<typeof ResolveOptionConidZodSchema>;
export type GetMarketDataInput = z.infer<typeof GetMarketDataZodSchema>;
export type PlaceOrderInput = z.infer<typeof PlaceOrderZodSchema>;
export type GetOrderStatusInput = z.infer<typeof GetOrderStatusZodSchema>;
export type GetLiveOrdersInput = z.infer<typeof GetLiveOrdersZodSchema>;
export type ConfirmOrderInput = z.infer<typeof ConfirmOrderZodSchema>;
export type GetAlertsInput = z.infer<typeof GetAlertsZodSchema>;
export type CreateAlertInput = z.infer<typeof CreateAlertZodSchema>;
export type ActivateAlertInput = z.infer<typeof ActivateAlertZodSchema>;
export type DeleteAlertInput = z.infer<typeof DeleteAlertZodSchema>;
export type GetFlexQueryInput = z.infer<typeof GetFlexQueryZodSchema>;
export type ListFlexQueriesInput = z.infer<typeof ListFlexQueriesZodSchema>;
export type ForgetFlexQueryInput = z.infer<typeof ForgetFlexQueryZodSchema>;
