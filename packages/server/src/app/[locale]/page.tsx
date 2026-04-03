import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('landing.hero');
  const tHeader = await getTranslations('layout.header');
  const tFeatures = await getTranslations('landing.features');
  const tSteps = await getTranslations('landing.steps');
  const tFooter = await getTranslations('landing.footer');
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      {/* Header */}
      <header className="container mx-auto px-4 py-6">
        <nav className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">
                DG
              </span>
            </div>
            <span className="font-semibold text-lg">DevGhost</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {tHeader('signIn')}
            </Link>
            <Link
              href="/register"
              className="text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors"
            >
              {tHeader('getStarted')}
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero Section */}
      <main className="container mx-auto px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl font-bold tracking-tight mb-6">
            {t.rich('title', {
              productivity: (chunks) => (
                <span key="productivity" className="text-primary">{chunks}</span>
              ),
            })}
          </h1>
          <p className="text-xl text-muted-foreground mb-10 max-w-2xl mx-auto">
            {t('description')}
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link
              href="/register"
              className="bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:bg-primary/90 transition-colors"
            >
              {t('getStartedFree')}
            </Link>
            <Link
              href="#features"
              className="border border-input bg-background px-6 py-3 rounded-lg font-medium hover:bg-accent transition-colors"
            >
              {t('learnMore')}
            </Link>
          </div>
        </div>

        {/* Features */}
        <section id="features" className="mt-32">
          <h2 className="text-3xl font-bold text-center mb-12">{t('features')}</h2>
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              title={tFeatures('aiEffort.title')}
              description={tFeatures('aiEffort.description')}
            />
            <FeatureCard
              title={tFeatures('ghostMetric.title')}
              description={tFeatures('ghostMetric.description')}
            />
            <FeatureCard
              title={tFeatures('teamAnalytics.title')}
              description={tFeatures('teamAnalytics.description')}
            />
          </div>
        </section>

        {/* How it works */}
        <section className="mt-32">
          <h2 className="text-3xl font-bold text-center mb-12">{t('howItWorks')}</h2>
          <div className="max-w-3xl mx-auto">
            <div className="space-y-8">
              <Step
                number={1}
                title={tSteps('addRepos.title')}
                description={tSteps('addRepos.description')}
              />
              <Step
                number={2}
                title={tSteps('runAnalysis.title')}
                description={tSteps('runAnalysis.description')}
              />
              <Step
                number={3}
                title={tSteps('reviewGhost.title')}
                description={tSteps('reviewGhost.description')}
              />
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="mt-32 text-center">
          <div className="bg-primary/5 rounded-2xl p-12">
            <h2 className="text-3xl font-bold mb-4">
              {t('ctaTitle')}
            </h2>
            <p className="text-muted-foreground mb-8">
              {t('ctaDescription')}
            </p>
            <Link
              href="/register"
              className="bg-primary text-primary-foreground px-8 py-4 rounded-lg font-medium hover:bg-primary/90 transition-colors inline-block"
            >
              {t('createAccount')}
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="container mx-auto px-4 py-8 mt-20 border-t">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{tFooter('brand')}</span>
          <span>{tFooter('version')}</span>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="bg-card border rounded-xl p-6 hover:shadow-lg transition-shadow">
      <h3 className="text-xl font-semibold mb-2">{title}</h3>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
}

function Step({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-10 h-10 bg-primary text-primary-foreground rounded-full flex items-center justify-center font-bold">
        {number}
      </div>
      <div>
        <h3 className="font-semibold text-lg">{title}</h3>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
    </div>
  );
}
