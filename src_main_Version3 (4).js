// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';

// The init() call configures the Actor for its environment
await Actor.init();

// Structure of input is defined in input_schema.json
const {
    startUrls = [
        { url: 'https://huggingface.co/models?sort=trending' },
        { url: 'https://huggingface.co/datasets?sort=trending' },
    ],
    maxRequestsPerCrawl = 20,
    scrapeTrendingModels = true,
    scrapeTrendingDatasets = true,
    trendingPeriod = 'daily',
    includeDetails = true,
    extractMetrics = true,
} = (await Actor.getInput()) ?? {};

// Filter URLs based on input
const filteredUrls = startUrls.filter((urlObj) => {
    const url = urlObj.url;
    if (url.includes('/models') && !scrapeTrendingModels) return false;
    if (url.includes('/datasets') && !scrapeTrendingDatasets) return false;
    return true;
});

// Proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration();

// Statistics tracking
const statistics = {
    modelsScraped: 0,
    datasetsScraped: 0,
    totalItems: 0,
    errors: 0,
    startTime: new Date(),
};

// Market intelligence data
const marketIntelligence = {
    topModels: [],
    topDatasets: [],
    taskBreakdown: {},
    licenseBreakdown: {},
    trendingScore: 0,
};

// Helper function to parse download/like numbers
function parseMetricNumber(str) {
    if (!str) return 0;
    const match = str.match(/[\d.]+/);
    if (!match) return 0;
    const num = parseFloat(match[0]);
    if (str.includes('k')) return num * 1000;
    if (str.includes('m')) return num * 1000000;
    return num;
}

// Helper function to extract model card details
async function getModelDetails($, modelUrl) {
    const details = {
        pipeline: null,
        framework: null,
        language: null,
        metrics: {},
    };

    try {
        // Extract tags/info from card
        const tags = [];
        $('.badge, .tag, [class*="badge"]').each((i, el) => {
            const text = $(el).text().trim();
            if (text) tags.push(text);
        });

        // Try to identify framework and language
        details.framework = tags.find((t) => ['PyTorch', 'TensorFlow', 'JAX', 'Transformers'].includes(t)) || null;
        details.language = tags.find((t) => /^[A-Z]{2}$|English|French|Spanish/.test(t)) || null;

        // Extract any metrics mentioned
        $('[class*="metric"], [class*="score"]').each((i, el) => {
            const text = $(el).text().trim();
            const match = text.match(/(.+?):\s*([\d.%]+)/);
            if (match) {
                details.metrics[match[1]] = match[2];
            }
        });
    } catch (error) {
        console.error(`Error extracting model details: ${error.message}`);
    }

    return details;
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, log }) {
        const url = request.loadedUrl;
        log.info(`Scraping: ${url}`);

        const isModelPage = url.includes('/models');
        const isDatasetPage = url.includes('/datasets');

        if (isModelPage) {
            // Scrape trending models
            const models = [];

            // Find all model cards
            $('article[data-testid="model-template"], .model-card, [class*="model-"]').each(async (i, el) => {
                const $card = $(el);

                // Extract basic info
                const name = $card.find('h3, h4, a[href*="/models/"]').first().text().trim();
                const link = $card.find('a[href*="/models/"]').first().attr('href');
                const fullUrl = link ? `https://huggingface.co${link}` : null;

                if (!name || !fullUrl) return;

                const description = $card.find('p, .description, [class*="desc"]').first().text().trim().slice(0, 200);

                // Extract metrics
                let downloads = 0;
                let likes = 0;
                let trendingScore = 0;

                $card.find('[class*="download"], [class*="metric"], span').each((j, el) => {
                    const text = $(el).text();
                    if (text.includes('download')) {
                        downloads = parseMetricNumber(text);
                    }
                    if (text.includes('❤️') || text.includes('like')) {
                        likes = parseMetricNumber(text);
                    }
                });

                // Calculate trending score (simplified)
                trendingScore = (downloads * 0.4 + likes * 0.6) / 1000;

                // Extract additional metadata
                const author = $card.find('a[href*="/user/"], a[href*="/org/"]').first().text().trim() || 'Unknown';
                const task = $card.find('[class*="tag"], .badge').first().text().trim() || 'General';
                const license = $card.find('[class*="license"]').text().trim() || 'Unknown';

                const model = {
                    name,
                    url: fullUrl,
                    author,
                    description,
                    downloads,
                    likes,
                    trendingScore,
                    task,
                    license,
                    type: 'model',
                    scrapedAt: new Date().toISOString(),
                    period: trendingPeriod,
                };

                models.push(model);

                // Get additional details if requested
                if (includeDetails) {
                    model.details = await getModelDetails($, fullUrl);
                }

                // Save to dataset
                await Dataset.pushData(model);
                statistics.modelsScraped++;
                statistics.totalItems++;

                log.info(`Saved model: ${name} (Score: ${trendingScore.toFixed(2)})`);
            });

            // Update market intelligence
            marketIntelligence.topModels = models
                .sort((a, b) => b.trendingScore - a.trendingScore)
                .slice(0, 10);

            // Task breakdown
            models.forEach((m) => {
                marketIntelligence.taskBreakdown[m.task] = (marketIntelligence.taskBreakdown[m.task] || 0) + 1;
            });

            // License breakdown
            models.forEach((m) => {
                marketIntelligence.licenseBreakdown[m.license] = (marketIntelligence.licenseBreakdown[m.license] || 0) + 1;
            });
        } else if (isDatasetPage) {
            // Scrape trending datasets
            const datasets = [];

            // Find all dataset cards
            $('article[data-testid="dataset-template"], .dataset-card, [class*="dataset-"]').each((i, el) => {
                const $card = $(el);

                // Extract basic info
                const name = $card.find('h3, h4, a[href*="/datasets/"]').first().text().trim();
                const link = $card.find('a[href*="/datasets/"]').first().attr('href');
                const fullUrl = link ? `https://huggingface.co${link}` : null;

                if (!name || !fullUrl) return;

                const description = $card.find('p, .description, [class*="desc"]').first().text().trim().slice(0, 200);

                // Extract metrics
                let downloads = 0;
                let likes = 0;
                let trendingScore = 0;

                $card.find('[class*="download"], [class*="metric"], span').each((j, el) => {
                    const text = $(el).text();
                    if (text.includes('download')) {
                        downloads = parseMetricNumber(text);
                    }
                    if (text.includes('❤️') || text.includes('like')) {
                        likes = parseMetricNumber(text);
                    }
                });

                // Calculate trending score
                trendingScore = (downloads * 0.4 + likes * 0.6) / 1000;

                // Extract metadata
                const author = $card.find('a[href*="/user/"], a[href*="/org/"]').first().text().trim() || 'Unknown';
                const size = $card.find('[class*="size"], [class*="storage"]').text().trim() || 'Unknown';

                const dataset = {
                    name,
                    url: fullUrl,
                    author,
                    description,
                    downloads,
                    likes,
                    trendingScore,
                    size,
                    type: 'dataset',
                    scrapedAt: new Date().toISOString(),
                    period: trendingPeriod,
                };

                datasets.push(dataset);

                // Save to dataset
                Dataset.pushData(dataset);
                statistics.datasetsScraped++;
                statistics.totalItems++;

                log.info(`Saved dataset: ${name} (Score: ${trendingScore.toFixed(2)})`);
            });

            // Update market intelligence
            marketIntelligence.topDatasets = datasets
                .sort((a, b) => b.trendingScore - a.trendingScore)
                .slice(0, 10);
        }

        // Enqueue next pages
        // Pagination logic for Hugging Face
        const nextPageLink = $('a[rel="next"], a:contains("Next"), [aria-label*="next"]').attr('href');
        if (nextPageLink) {
            const nextUrl = nextPageLink.startsWith('http') ? nextPageLink : `https://huggingface.co${nextPageLink}`;
            // Only enqueue if we haven't reached max requests
            if (statistics.totalItems < maxRequestsPerCrawl * 30) {
                // Assuming ~30 items per page
                await crawler.addRequests([{ url: nextUrl }]);
            }
        }
    },

    errorHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url}`, error);
        statistics.errors++;
    },
});

// Run the crawler
try {
    await crawler.run(filteredUrls);
} catch (error) {
    console.error('Crawler error:', error);
    statistics.errors++;
}

// Calculate overall trending score
marketIntelligence.trendingScore = (marketIntelligence.topModels[0]?.trendingScore || 0 + marketIntelligence.topDatasets[0]?.trendingScore || 0) / 2;

// Prepare market report
const marketReport = {
    reportDate: new Date().toISOString(),
    period: trendingPeriod,
    summary: {
        totalModelsScraped: statistics.modelsScraped,
        totalDatasetsScraped: statistics.datasetsScraped,
        totalItems: statistics.totalItems,
    },
    topTrending: {
        models: marketIntelligence.topModels.slice(0, 5),
        datasets: marketIntelligence.topDatasets.slice(0, 5),
    },
    breakdown: {
        tasks: marketIntelligence.taskBreakdown,
        licenses: marketIntelligence.licenseBreakdown,
    },
    insights: {
        mostPopularTask: Object.entries(marketIntelligence.taskBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A',
        mostPopularLicense: Object.entries(marketIntelligence.licenseBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A',
        averageTrendingScore: (
            (marketIntelligence.topModels.reduce((sum, m) => sum + m.trendingScore, 0) +
                marketIntelligence.topDatasets.reduce((sum, d) => sum + d.trendingScore, 0)) /
            (statistics.totalItems || 1)
        ).toFixed(2),
    },
};

// Save market report and statistics to Key-Value Store
const kvStore = await KeyValueStore.open();
await kvStore.setValue('MARKET_REPORT', marketReport);
await kvStore.setValue('STATISTICS', {
    ...statistics,
    endTime: new Date(),
    duration: new Date() - statistics.startTime,
});

// Historical trends (append to existing data)
try {
    const existingTrends = await kvStore.getValue('HISTORICAL_TRENDS');
    const trends = existingTrends ? JSON.parse(existingTrends) : [];
    trends.push({
        date: new Date().toISOString(),
        period: trendingPeriod,
        summary: marketReport.summary,
        topModels: marketIntelligence.topModels.map((m) => ({ name: m.name, score: m.trendingScore })),
        topDatasets: marketIntelligence.topDatasets.map((d) => ({ name: d.name, score: d.trendingScore })),
    });

    // Keep only last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const filtered = trends.filter((t) => new Date(t.date) > thirtyDaysAgo);

    await kvStore.setValue('HISTORICAL_TRENDS', JSON.stringify(filtered));
} catch (error) {
    console.error('Error updating historical trends:', error);
}

console.log('\n=== Hugging Face Trending Scrape Complete ===');
console.log(`Models scraped: ${statistics.modelsScraped}`);
console.log(`Datasets scraped: ${statistics.datasetsScraped}`);
console.log(`Total items: ${statistics.totalItems}`);
console.log(`Errors: ${statistics.errors}`);
console.log(`\nMarket Report Summary:`);
console.log(`Most Popular Task: ${marketReport.insights.mostPopularTask}`);
console.log(`Most Popular License: ${marketReport.insights.mostPopularLicense}`);
console.log(`Average Trending Score: ${marketReport.insights.averageTrendingScore}`);

// Gracefully exit the Actor process
await Actor.exit();