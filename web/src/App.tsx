import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Breadcrumbs, type Crumb } from "./components/Breadcrumbs";
import { KpiGrid } from "./components/KpiGrid";
import { PerformanceChart } from "./components/PerformanceChart";
import { PerformanceTable } from "./components/PerformanceTable";
import { DetailDrawer } from "./components/DetailDrawer";
import { ClaudeChat } from "./components/ClaudeChat";
import {
  Card,
  EmptyState,
  ErrorState,
  KpiSkeletonGrid,
  Skeleton,
  TableSkeleton,
} from "./components/states";
import {
  useAccounts,
  useAdSets,
  useAds,
  useCampaigns,
  useEntityInsights,
  useInsights,
  useSession,
  type RangeParams,
} from "./api/queries";
import { isConnectionError } from "./api/client";
import type { Campaign, EntityRow } from "./api/types";
import {
  AI,
  CAMPAIGNS,
  OVERVIEW,
  adSetsOf,
  adsOf,
  askClaudeQuestion,
  detailOf,
  resetForAccountChange,
  type DetailTarget,
  type NavState,
} from "./lib/nav";

const SELECTED_ACCOUNT_KEY = "ads-ai-manager:selected-account";
const RANGE_KEY = "ads-ai-manager:range-preset";

/**
 * Only the account id and the chosen preset are persisted. Both are
 * user-visible selections, never credentials — nothing sensitive is written to
 * browser storage anywhere in this app.
 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the selection simply does not persist */
  }
}

/**
 * The campaigns endpoint predates the drill-down and keeps its Phase 1 shape,
 * so its rows are lifted into the shared row type here rather than by changing
 * an endpoint the MCP-era tests pin.
 */
function campaignToRow(campaign: Campaign): EntityRow {
  return {
    id: campaign.id,
    level: "campaign",
    name: campaign.name,
    status: campaign.status,
    effectiveStatus: campaign.effectiveStatus,
    objective: campaign.objective,
    campaignId: campaign.id,
    campaignName: campaign.name,
    adSetId: null,
    adSetName: null,
    creativeId: null,
    dailyBudget: campaign.dailyBudget,
    lifetimeBudget: campaign.lifetimeBudget,
    metrics: campaign.metrics,
  };
}

export function App() {
  const queryClient = useQueryClient();
  const [nav, setNav] = useState<NavState>(OVERVIEW);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  // Set when the user hands an entity to Claude from the detail drawer; the
  // chat view consumes it once and clears it.
  const [aiPrefill, setAiPrefill] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readStored(SELECTED_ACCOUNT_KEY),
  );
  const [range, setRange] = useState<RangeParams>(() => ({
    preset: readStored(RANGE_KEY) ?? "last_30d",
  }));

  const session = useSession();
  const accounts = useAccounts(session.isSuccess);
  const accountList = accounts.data?.accounts ?? [];

  // The stored id is a hint, never an authorization: the server re-checks it on
  // every request, and a stale id simply falls back to the first account.
  const selectedAccount = useMemo(() => {
    if (accountList.length === 0) return null;
    return accountList.find((account) => account.id === selectedId) ?? accountList[0];
  }, [accountList, selectedId]);

  useEffect(() => {
    if (selectedAccount && selectedAccount.id !== selectedId) {
      setSelectedId(selectedAccount.id);
    }
  }, [selectedAccount, selectedId]);

  const accountId = selectedAccount?.id ?? null;

  const insights = useInsights(nav.view === "overview" ? accountId : null, range);
  const campaigns = useCampaigns(nav.view === "campaigns" ? accountId : null, range);
  const adSets = useAdSets(
    nav.view === "adsets" ? accountId : null,
    nav.view === "adsets" ? nav.campaignId : null,
    range,
  );
  const ads = useAds(
    nav.view === "ads" ? accountId : null,
    nav.view === "ads" ? nav.adSetId : null,
    range,
  );
  const detailInsights = useEntityInsights(accountId, detail, range);

  const handleSelectAccount = (id: string) => {
    setSelectedId(id);
    writeStored(SELECTED_ACCOUNT_KEY, id);
    // Ids below the account belong to the old account and would only 403.
    setNav((current) => resetForAccountChange(current));
    setDetail(null);
  };

  const handleRangeChange = (next: RangeParams) => {
    setRange(next);
    writeStored(RANGE_KEY, next.preset);
  };

  const refreshing =
    session.isFetching ||
    accounts.isFetching ||
    insights.isFetching ||
    campaigns.isFetching ||
    adSets.isFetching ||
    ads.isFetching;

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const crumbs: Crumb[] = useMemo(() => {
    const list: Crumb[] = [
      nav.view === "overview"
        ? { label: "Genel Bakış" }
        : { label: "Genel Bakış", onClick: () => setNav(OVERVIEW) },
    ];
    if (nav.view === "overview") return list;

    if (nav.view === "ai") {
      list.push({ label: "Claude AI" });
      return list;
    }

    list.push(
      nav.view === "campaigns"
        ? { label: "Kampanyalar" }
        : { label: "Kampanyalar", onClick: () => setNav(CAMPAIGNS) },
    );
    if (nav.view === "campaigns") return list;

    list.push(
      nav.view === "adsets"
        ? { label: `Ad Setler · ${nav.campaignName}` }
        : {
            label: `Ad Setler · ${nav.campaignName}`,
            onClick: () =>
              setNav({
                view: "adsets",
                campaignId: nav.campaignId,
                campaignName: nav.campaignName,
              }),
          },
    );
    if (nav.view === "adsets") return list;

    list.push({ label: `Reklamlar · ${nav.adSetName}` });
    return list;
  }, [nav]);

  // A dead session or a missing Meta token makes every panel below useless, so
  // it takes over the whole page rather than repeating in each card.
  const fatalError =
    (session.isError && session.error) ||
    (accounts.isError && isConnectionError(accounts.error) ? accounts.error : null);

  if (fatalError) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <ErrorState error={fatalError} onRetry={() => void session.refetch()} />
        </Card>
      </div>
    );
  }

  const currency = selectedAccount?.currency ?? "TRY";

  return (
    <div className="flex min-h-full">
      <Sidebar
        active={nav.view === "overview" || nav.view === "ai" ? nav.view : "campaigns"}
        onSelect={(view) => {
          setNav(view === "overview" ? OVERVIEW : view === "ai" ? AI : CAMPAIGNS);
          setDetail(null);
        }}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          session={session.data}
          accounts={accountList}
          selectedAccount={selectedAccount}
          onSelectAccount={handleSelectAccount}
          range={range}
          onRangeChange={handleRangeChange}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          onOpenMenu={() => setMenuOpen(true)}
          breadcrumbs={<Breadcrumbs crumbs={crumbs} />}
        />

        <main className="flex-1 space-y-4 p-4 sm:p-6">
          {accounts.isPending ? (
            <div className="space-y-4">
              <Skeleton className="h-8 w-56" />
              <KpiSkeletonGrid />
            </div>
          ) : accounts.isError ? (
            <Card>
              <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
            </Card>
          ) : accountList.length === 0 ? (
            <Card>
              <EmptyState
                title="Reklam hesabı bulunamadı"
                description="Bağlı Meta kullanıcısının eriştiği bir reklam hesabı yok. Bağlantıları yönetin ya da farklı bir Meta hesabıyla giriş yapın."
              />
            </Card>
          ) : nav.view === "overview" ? (
            <>
              {insights.isPending ? (
                <KpiSkeletonGrid />
              ) : insights.isError ? (
                <Card>
                  <ErrorState error={insights.error} onRetry={() => void insights.refetch()} />
                </Card>
              ) : insights.data.summary.impressions === 0 && insights.data.summary.spend === 0 ? (
                <Card>
                  <EmptyState
                    title="Seçili aralıkta veri yok"
                    description="Bu reklam hesabı için seçtiğiniz tarih aralığında harcama veya gösterim kaydedilmemiş."
                  />
                </Card>
              ) : (
                <KpiGrid
                  metrics={insights.data.summary}
                  currency={insights.data.account.currency}
                  comparison={insights.data.comparison}
                />
              )}

              {insights.isPending ? (
                <Card className="p-4">
                  <Skeleton className="h-64 w-full" />
                </Card>
              ) : insights.isSuccess ? (
                <PerformanceChart
                  series={insights.data.series}
                  currency={insights.data.account.currency}
                />
              ) : null}
            </>
          ) : nav.view === "ai" ? (
            <ClaudeChat
              accountId={accountId}
              accountName={selectedAccount?.name ?? ""}
              prefill={aiPrefill}
              onPrefillConsumed={() => setAiPrefill(null)}
            />
          ) : nav.view === "campaigns" ? (
            campaigns.isPending ? (
              <Card>
                <TableSkeleton />
              </Card>
            ) : campaigns.isError ? (
              <Card>
                <ErrorState error={campaigns.error} onRetry={() => void campaigns.refetch()} />
              </Card>
            ) : (
              <PerformanceTable
                title="Kampanyalar"
                level="campaign"
                rows={campaigns.data.campaigns.map(campaignToRow)}
                currency={campaigns.data.account.currency || currency}
                onDrillDown={(row) => setNav(adSetsOf(row))}
                onOpenDetail={(row) => setDetail(detailOf(row))}
                emptyTitle="Kampanya bulunamadı"
                emptyDescription="Bu reklam hesabında henüz kampanya yok."
              />
            )
          ) : nav.view === "adsets" ? (
            adSets.isPending ? (
              <Card>
                <TableSkeleton />
              </Card>
            ) : adSets.isError ? (
              <Card>
                <ErrorState error={adSets.error} onRetry={() => void adSets.refetch()} />
              </Card>
            ) : (
              <PerformanceTable
                title={`Ad Setler · ${nav.campaignName}`}
                level="adset"
                rows={adSets.data.rows}
                currency={adSets.data.account.currency || currency}
                onDrillDown={(row) => setNav(adsOf(nav, row))}
                onOpenDetail={(row) => setDetail(detailOf(row))}
                emptyTitle="Reklam seti bulunamadı"
                emptyDescription="Bu kampanyada reklam seti yok."
              />
            )
          ) : ads.isPending ? (
            <Card>
              <TableSkeleton />
            </Card>
          ) : ads.isError ? (
            <Card>
              <ErrorState error={ads.error} onRetry={() => void ads.refetch()} />
            </Card>
          ) : (
            <PerformanceTable
              title={`Reklamlar · ${nav.adSetName}`}
              level="ad"
              rows={ads.data.rows}
              currency={ads.data.account.currency || currency}
              onOpenDetail={(row) => setDetail(detailOf(row))}
              emptyTitle="Reklam bulunamadı"
              emptyDescription="Bu reklam setinde reklam yok."
            />
          )}
        </main>
      </div>

      <DetailDrawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.name ?? ""}
        data={detailInsights.data}
        isPending={detailInsights.isPending}
        isError={detailInsights.isError}
        error={detailInsights.error}
        onRetry={() => void detailInsights.refetch()}
        onAskClaude={
          detail
            ? () => {
                setAiPrefill(askClaudeQuestion(detail));
                setDetail(null);
                setNav(AI);
              }
            : undefined
        }
      />
    </div>
  );
}
