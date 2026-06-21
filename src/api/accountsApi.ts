import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from "@reduxjs/toolkit/query/react";
import * as i18nextNs from "i18next";
import { readAccessToken, tryRefreshToken, clearSessionAndRedirect } from "@/lib/auth";

// Federation interop: normalize the shared i18next namespace to the real instance.
const i18next = ((i18nextNs as unknown as { default?: typeof import("i18next").default }).default
  ?? (i18nextNs as unknown as typeof import("i18next").default));
import type {
  Account,
  OpenAccountRequest,
  SpendingInsights,
  Transaction,
} from "./types";

/**
 * RTK Query api slice for the Accounts remote.
 *
 * DESIGNED FOR BOTH MODES (see src/lib/auth.ts for the full contract):
 *   - STANDALONE: this slice lives in the remote's OWN store (src/store.ts) and talks to the
 *     gateway through Vite's /api proxy.
 *   - EMBEDDED: ideally the shell injects this reducer/middleware into its store. Either way,
 *     auth is decoupled from the store — `prepareHeaders` reads the token at REQUEST TIME from
 *     the shared channel (`readAccessToken`), so we always send the shell's current Bearer
 *     token without needing the token in our own Redux state.
 *
 * `baseUrl` is "/api" (relative): standalone it hits the Vite proxy; embedded it hits the
 * shell's origin which fronts the same gateway. No absolute host is ever baked in.
 */
const rawBaseQuery = fetchBaseQuery({
  baseUrl: "/api",
  prepareHeaders: (headers) => {
    // Bearer token: resolved fresh per request from the shared auth channel.
    const token = readAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    // Accept-Language drives the backend's localized AI summary + any localized messages.
    // Always read the LIVE i18next language so language switches in the shell propagate.
    headers.set("Accept-Language", i18next.language || "en");
    return headers;
  },
});

// On a 401 (expired access token) try ONE silent refresh, then retry the request. If the
// refresh fails (no/expired refresh token), bounce to login instead of dead-ending.
const baseQueryWithReauth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  apiCtx,
  extraOptions,
) => {
  let result = await rawBaseQuery(args, apiCtx, extraOptions);
  if (result.error && result.error.status === 401) {
    const fresh = await tryRefreshToken();
    if (fresh) {
      result = await rawBaseQuery(args, apiCtx, extraOptions); // prepareHeaders re-reads the new token
    } else {
      clearSessionAndRedirect();
    }
  }
  return result;
};

export const accountsApi = createApi({
  // Unique reducerPath so this slice can be safely combined into the shell's store
  // alongside the shell's own / other remotes' slices without key collisions.
  reducerPath: "accountsApi",
  baseQuery: baseQueryWithReauth,
  tagTypes: ["Account", "Transactions"],
  endpoints: (builder) => ({
    /** GET /api/accounts — list all accounts for the authenticated customer. */
    listAccounts: builder.query<Account[], void>({
      query: () => "/accounts",
      providesTags: (result) =>
        result
          ? [
              ...result.map((a) => ({ type: "Account" as const, id: a.id })),
              { type: "Account" as const, id: "LIST" },
            ]
          : [{ type: "Account" as const, id: "LIST" }],
    }),

    /** GET /api/accounts/{id} — one account. */
    getAccount: builder.query<Account, string>({
      query: (id) => `/accounts/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Account", id }],
    }),

    /** GET /api/accounts/{id}/transactions — ledger entries for the account-detail table. */
    getAccountTransactions: builder.query<Transaction[], string>({
      query: (id) => `/accounts/${id}/transactions`,
      providesTags: (_r, _e, id) => [{ type: "Transactions", id }],
    }),

    /**
     * GET /api/insights/spending?customerId=… — category breakdown + localized AI summary.
     * The backend REQUIRES the customerId query param, so we pass the customer id taken
     * from the loaded accounts (omitting it returns HTTP 400).
     */
    getSpendingInsights: builder.query<SpendingInsights, string>({
      query: (customerId) =>
        `/insights/spending?customerId=${encodeURIComponent(customerId)}`,
    }),

    /** POST /api/accounts — open a new account. Invalidates the list so it refetches. */
    openAccount: builder.mutation<Account, OpenAccountRequest>({
      query: (body) => ({
        url: "/accounts",
        method: "POST",
        body,
      }),
      invalidatesTags: [{ type: "Account", id: "LIST" }],
    }),
  }),
});

export const {
  useListAccountsQuery,
  useGetAccountQuery,
  useGetAccountTransactionsQuery,
  useGetSpendingInsightsQuery,
  useOpenAccountMutation,
} = accountsApi;
