import puppeteer, { Browser, Page } from 'puppeteer';
import { parse } from 'node-html-parser';
import { convert } from 'html-to-text';
import { supabase } from '../config/database';
import { voyageai, VOYAGEAI_MODEL } from '../config/embedding';
import logger from '../utils/logger';
import { DuplicateTracker } from '../utils/duplicateTracker';

interface ArcherNewsArticle {
  url: string;
  title: string;
  category: string; // 'press release', 'news', or 'blog'
}

interface ArcherNewsContent {
  title: string;
  rawHtml: string;  // Raw HTML for database storage
  cleanText: string; // Clean text for embedding generation
  category: string;
}

interface NewsData {
  url: string;
  title: string;
  content: string;
  source: string;
  published_date: Date;
  news_type: string;
  article_category: string;
  company_name: string;
  author?: string;
  publication: string;
  tags: string[];
  sentiment: string;
  impact_level: string;
  credibility_score: number;
  geographic_focus: string[];
  industry_focus: string[];
  related_companies: string[];
  press_contact?: { email: string };
  metadata: any;
  word_count: number;
  language: string;
}

export class ArcherAviationService {
  private newsBrowser: Browser | null = null;
  private newsPage: Page | null = null;
  private readonly NEWS_BASE_URL = 'https://news.archer.com/';
  private readonly COMPANY_NAME = 'Archer Aviation';

  // Helper: Delay function
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper: Check if record exists
  private async recordExists(url: string): Promise<boolean> {
    try {
      const { count } = await supabase
        .from('news')
        .select('*', { count: 'exact', head: true })
        .eq('url', url);

      return (count || 0) > 0;
    } catch (error) {
      logger.warn(`Failed to check if record exists for URL ${url}:`, error);
      return false;
    }
  }

  // Helper: Generate embedding
  private async generateEmbedding(content: string, retries: number = 3): Promise<number[]> {
    const maxRetries = retries;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        if (attempt > 0) {
          const backoffDelay = Math.min(20000 * Math.pow(2, attempt - 1), 60000);
          logger.info(`Waiting ${backoffDelay}ms before retry ${attempt + 1}/${maxRetries}...`);
          await this.delay(backoffDelay);
        } else {
          await this.delay(20000); // Initial delay to respect rate limits
        }
        
        const response = await voyageai.embed({
          input: [content],
          model: VOYAGEAI_MODEL!
        });
        return response.data?.[0]?.embedding || [];
      } catch (error: any) {
        attempt++;
        
        if (error?.statusCode === 429 || error?.message?.includes('429')) {
          if (attempt < maxRetries) {
            const retryAfter = error?.body?.retry_after || 20;
            const delay = retryAfter * 1000;
            logger.warn(`Rate limit hit (429). Retrying after ${delay}ms (attempt ${attempt}/${maxRetries})...`);
            await this.delay(delay);
            continue;
          } else {
            logger.error('Rate limit error after max retries:', error);
            throw new Error(`Rate limit exceeded after ${maxRetries} attempts. ${error?.body?.detail || error.message}`);
          }
        }
        
        logger.error('Error generating embedding:', error);
        throw error;
      }
    }
    
    throw new Error('Failed to generate embedding after all retries');
  }

  // Helper: Store news
  private async storeNews(newsData: NewsData, embedding: number[]): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('news')
        .insert([{
          url: newsData.url,
          title: newsData.title,
          content: newsData.content,
          source: newsData.source,
          published_date: newsData.published_date.toISOString(),
          news_type: newsData.news_type,
          article_category: newsData.article_category,
          company_name: newsData.company_name,
          author: newsData.author,
          publication: newsData.publication,
          tags: newsData.tags,
          sentiment: newsData.sentiment,
          impact_level: newsData.impact_level,
          credibility_score: newsData.credibility_score,
          geographic_focus: newsData.geographic_focus,
          industry_focus: newsData.industry_focus,
          related_companies: newsData.related_companies,
          press_contact: newsData.press_contact,
          metadata: newsData.metadata,
          word_count: newsData.word_count,
          language: newsData.language,
          embedding: embedding
        }])
        .select('id')
        .single();

      if (error) {
        logger.error('Error storing news:', error);
        throw error;
      }

      return data.id;
    } catch (error) {
      logger.error('Error storing news:', error);
      throw error;
    }
  }

  // Helper: Calculate word count
  private calculateWordCount(content: string): number {
    return content.split(/\s+/).filter(word => word.length > 0).length;
  }

  // Helper: Analyze sentiment
  private analyzeSentiment(content: string): string {
    const lowerContent = content.toLowerCase();
    const positiveWords = ['success', 'achievement', 'milestone', 'partnership', 'innovation', 'breakthrough', 'approval'];
    const negativeWords = ['challenge', 'delay', 'issue', 'concern', 'risk'];

    const positiveCount = positiveWords.filter(word => lowerContent.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lowerContent.includes(word)).length;

    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }

  // Helper: Assess impact level
  private assessImpactLevel(content: string): string {
    const lowerContent = content.toLowerCase();
    const highImpactWords = ['major', 'significant', 'milestone', 'historic', 'breakthrough', 'first', 'record'];
    const highImpactCount = highImpactWords.filter(word => lowerContent.includes(word)).length;

    if (highImpactCount >= 2) return 'high';
    if (highImpactCount === 1) return 'medium';
    return 'low';
  }

  // Helper: Extract geographic focus
  private extractGeographicFocus(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const locations: string[] = [];

    if (lowerContent.includes('uae') || lowerContent.includes('abu dhabi') || lowerContent.includes('dubai')) locations.push('United Arab Emirates');
    if (lowerContent.includes('california') || lowerContent.includes('los angeles')) locations.push('United States');
    if (lowerContent.includes('japan') || lowerContent.includes('osaka')) locations.push('Japan');
    if (lowerContent.includes('new york')) locations.push('United States');
    if (lowerContent.includes('india')) locations.push('India');

    return [...new Set(locations)];
  }

  // Helper: Extract related companies
  private extractRelatedCompanies(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const companies: string[] = ['Archer Aviation'];

    if (lowerContent.includes('united airlines') || lowerContent.includes('united')) companies.push('United Airlines');
    if (lowerContent.includes('southwest')) companies.push('Southwest Airlines');
    if (lowerContent.includes('stellantis')) companies.push('Stellantis');
    if (lowerContent.includes('japan airlines') || lowerContent.includes('jal')) companies.push('Japan Airlines');
    if (lowerContent.includes('cleveland clinic')) companies.push('Cleveland Clinic');

    return [...new Set(companies)];
  }

  // Helper: Generate tags
  private generateTags(content: string): string[] {
    const tags: string[] = [];
    const lowerContent = content.toLowerCase();
    
    const tagMappings = [
      { keywords: ['air taxi', 'air taxi service'], tag: 'air taxi' },
      { keywords: ['evtol', 'e-vtol'], tag: 'eVTOL' },
      { keywords: ['midnight'], tag: 'Midnight' },
      { keywords: ['vertiport'], tag: 'vertiport' },
      { keywords: ['faa', 'federal aviation administration'], tag: 'FAA certification' },
      { keywords: ['flight test', 'test flight'], tag: 'flight testing' },
      { keywords: ['partnership', 'collaboration'], tag: 'partnership' },
      { keywords: ['urban air mobility', 'uam'], tag: 'urban air mobility' },
      { keywords: ['certification'], tag: 'certification' },
    ];

    for (const mapping of tagMappings) {
      if (mapping.keywords.some(keyword => lowerContent.includes(keyword))) {
        tags.push(mapping.tag);
      }
    }

    return tags;
  }

  // Extract date from title (format: "October 8, 2025 | Title")
  private extractDateFromTitle(title: string): Date {
    try {
      const dateMatch = title.match(/^([A-Za-z]+ \d{1,2}, \d{4})/);
      if (dateMatch) {
        const date = new Date(dateMatch[1]);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
      return new Date();
    } catch {
      return new Date();
    }
  }

  // Initialize browser for news crawling
  private async initializeNewsBrowser(): Promise<void> {
    try {
      logger.info('Initializing Archer News browser...');
      
      this.newsBrowser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });

      this.newsPage = await this.newsBrowser.newPage();
      
      await this.newsPage.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });
      
      await this.newsPage.setViewport({ width: 1920, height: 1080 });
      this.newsPage.setDefaultNavigationTimeout(120000);
      
      await this.newsPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );
      
      // Remove automation indicators
      await this.newsPage.evaluateOnNewDocument(() => {
        // @ts-ignore - browser context
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
        
        // @ts-ignore - browser context
        window.navigator.chrome = {
          runtime: {},
        };
        
        // @ts-ignore - browser context
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        
        // @ts-ignore - browser context
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      });
      
      logger.info('News browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize news browser:', error);
      throw error;
    }
  }

  // Cleanup news browser
  private async cleanupNewsBrowser(): Promise<void> {
    try {
      if (this.newsPage) {
        await this.newsPage.close();
        this.newsPage = null;
      }
      if (this.newsBrowser) {
        await this.newsBrowser.close();
        this.newsBrowser = null;
      }
      logger.info('News browser closed successfully');
    } catch (error) {
      logger.error('Error during news browser cleanup:', error);
    }
  }

  // Load all news articles by clicking "More News" until it disappears
  private async loadAllNewsArticles(): Promise<void> {
    let loadMoreAttempts = 0;
    const maxLoadMoreAttempts = 100;
    
    while (loadMoreAttempts < maxLoadMoreAttempts) {
      try {
        await this.delay(2000);
        
        const moreNewsButton = await this.newsPage!.evaluate(() => {
          // @ts-ignore - browser context
          const elements = Array.from(document.querySelectorAll('li, button, a'));
          const moreNewsBtn = elements.find((el: any) => 
            el.textContent?.trim() === 'More News' && 
            el.classList.contains('cursor-pointer')
          ) as any;
          if (moreNewsBtn) {
            moreNewsBtn.setAttribute('data-load-more', 'true');
            return true;
          }
          return false;
        });
        
        if (!moreNewsButton) {
          logger.info('No "More News" button found - all articles loaded');
          break;
        }

        logger.info(`Clicking "More News" button (attempt ${loadMoreAttempts + 1})...`);
        
        const articleCountBefore = await this.newsPage!.evaluate(() => {
          // @ts-ignore - browser context
          return document.querySelectorAll('#news_content > div').length;
        });
        
        await this.newsPage!.evaluate(() => {
          // @ts-ignore - browser context
          const button = document.querySelector('[data-load-more="true"]') as any;
          if (button) {
            button.click();
          }
        });
        
        await this.delay(3000);
        
        const articleCountAfter = await this.newsPage!.evaluate(() => {
          // @ts-ignore - browser context
          return document.querySelectorAll('#news_content > div').length;
        });
        
        loadMoreAttempts++;
        
        logger.info(`Articles before: ${articleCountBefore}, after: ${articleCountAfter}`);
        
        if (articleCountAfter === articleCountBefore) {
          logger.info('No new articles loaded - all articles loaded');
          break;
        }
        
      } catch (error) {
        logger.error(`Error during More News attempt ${loadMoreAttempts + 1}:`, error);
        break;
      }
    }

    logger.info(`Completed loading articles after ${loadMoreAttempts} "More News" clicks`);
  }

  // Extract news articles from the page
  private async extractNewsArticles(category: string): Promise<ArcherNewsArticle[]> {
    const articles = await this.newsPage!.evaluate((): ArcherNewsArticle[] => {
      // @ts-ignore - browser context
      const newsSection = document.querySelector('#news_content');
      if (!newsSection) return [];
      
      const articleDivs = newsSection.querySelectorAll('div.p-4');
      const articles: ArcherNewsArticle[] = [];
      
      articleDivs.forEach((div: any) => {
        const eyebrow = div.querySelector('.eyebrow-text')?.textContent?.trim() || '';
        const titleElement = div.querySelector('.secondary-headline');
        const title = titleElement?.textContent?.trim() || '';
        const link = div.querySelector('a.action');
        const href = link?.getAttribute('href') || '';
        
        if (href && title) {
          articles.push({
            url: `https://news.archer.com${href}`,
            title,
            category: eyebrow
          });
        }
      });
      
      const uniqueArticles = articles.filter((article, index, self) => 
        index === self.findIndex(a => a.url === article.url)
      );
      
      return uniqueArticles;
    });

    logger.info(`Extracted ${articles.length} unique articles from category: ${category}`);
    
    if (articles.length > 0) {
      logger.info(`Sample article: ${articles[0].title} - ${articles[0].url}`);
    }
    
    return articles;
  }

  // Fetch detailed content from a single news article page
  async fetchArticleContentDirect(url: string): Promise<ArcherNewsContent | null> {
    try {
      if (!this.newsPage) {
        await this.initializeNewsBrowser();
      }

      logger.info(`Fetching content from: ${url}`);
      
      let navigationSuccess = false;
      let retries = 3;
      
      while (retries > 0 && !navigationSuccess) {
        try {
          await this.newsPage!.goto(url);
          navigationSuccess = true;
        } catch (error) {
          retries--;
          logger.warn(`Article navigation failed, retries remaining: ${retries}`);
          if (retries > 0) {
            await this.delay(2000);
          } else {
            throw error;
          }
        }
      }

      try {
        await this.newsPage!.waitForSelector('.articles, .secondary-headline', { timeout: 15000 });
      } catch {}
      
      await this.delay(1500);

      const pageData = await this.newsPage!.evaluate(() => {
        // @ts-ignore - browser context
        const titleEl = document.querySelector('.secondary-headline');
        const title = titleEl?.textContent?.trim() || '';
        
        // @ts-ignore - browser context
        const contentEl = document.querySelector('.articles');
        const rawHTML = contentEl?.innerHTML || '';
        
        // @ts-ignore - browser context
        const eyebrow = document.querySelector('.eyebrow-text')?.textContent?.trim() || '';
        
        return { title, rawHTML, category: eyebrow };
      });

      if (!pageData.title || !pageData.rawHTML) {
        logger.warn(`No content found for: ${url}`);
        return null;
      }

      // Parse HTML to clean text (for embedding generation only)
      const root = parse(pageData.rawHTML);
      
      const unwantedSelectors = [
        'script', 'style', 'noscript', 'svg', 'img', 'button', 
        'nav', 'header', 'footer', 'aside'
      ];
      
      unwantedSelectors.forEach(selector => {
        root.querySelectorAll(selector).forEach(el => el.remove());
      });
      
      const content = root.text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

      const fallbackContent = convert(pageData.rawHTML, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'br', format: 'lineBreak' },
          { selector: 'p', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
        ],
      }).trim();

      const cleanText = content.length >= 80 ? content : fallbackContent;

      return {
        title: pageData.title,
        rawHtml: pageData.rawHTML,  // Store raw HTML in database
        cleanText: cleanText,       // Use clean text for embedding
        category: pageData.category
      };

    } catch (error) {
      logger.error(`Failed to fetch content from ${url}:`, error);
      return null;
    }
  }

  // Process and store a single article
  async processAndStoreArticle(article: ArcherNewsArticle, duplicateTracker?: DuplicateTracker): Promise<{ processed: boolean; isDuplicate: boolean }> {
    try {
      // Use duplicate tracker if provided, otherwise fall back to recordExists
      let isDuplicate = false;
      if (duplicateTracker) {
        const checkResult = await duplicateTracker.processCheck(article.url);
        isDuplicate = checkResult.isDuplicate;
        if (checkResult.shouldStop) {
          return { processed: false, isDuplicate: true };
        }
      } else {
        isDuplicate = await this.recordExists(article.url);
      }

      if (isDuplicate) {
        logger.info(`Content already exists, skipping: ${article.url}`);
        return { processed: false, isDuplicate: true };
      }

      const fullContent = await this.fetchArticleContentDirect(article.url);
      if (!fullContent) {
        logger.warn(`Failed to fetch content for: ${article.url}`);
        return { processed: false, isDuplicate: false };
      }

      if (!fullContent.rawHtml || fullContent.rawHtml.trim().length === 0) {
        logger.warn(`No meaningful content found for: ${article.url}`);
        return { processed: false, isDuplicate: false };
      }

      // Use clean text for word count and analysis
      const wordCount = this.calculateWordCount(fullContent.cleanText);

      // Determine news type based on category
      let newsType = 'press_release';
      let articleCategory = 'press_release';
      
      const categoryLower = fullContent.category.toLowerCase();
      if (categoryLower.includes('blog')) {
        newsType = 'blog_post';
        articleCategory = 'blog_post';
      } else if (categoryLower.includes('news')) {
        newsType = 'news';
        articleCategory = 'news';
      } else if (categoryLower.includes('press')) {
        newsType = 'press_release';
        articleCategory = 'press_release';
      }

      // Generate embedding from clean text only
      logger.info(`Generating embedding for: ${fullContent.title} (${wordCount} words)`);
      const embedding = await this.generateEmbedding(fullContent.cleanText);

      const newsData: NewsData = {
        url: article.url,
        title: fullContent.title,
        content: fullContent.rawHtml,  // Store raw HTML in content field
        source: 'archer_aviation',
        published_date: this.extractDateFromTitle(fullContent.title),
        news_type: newsType,
        article_category: articleCategory,
        company_name: this.COMPANY_NAME,
        publication: 'Archer Aviation',
        tags: this.generateTags(fullContent.cleanText),  // Use clean text for analysis
        sentiment: this.analyzeSentiment(fullContent.cleanText),
        impact_level: this.assessImpactLevel(fullContent.cleanText),
        credibility_score: 0.95,
        geographic_focus: this.extractGeographicFocus(fullContent.cleanText),
        industry_focus: ['eVTOL', 'Urban Air Mobility', 'Aviation', 'Electric Aircraft'],
        related_companies: this.extractRelatedCompanies(fullContent.cleanText),
        metadata: {
          snippet: fullContent.title,
          source: 'archer_aviation',
          url: article.url,
          category: articleCategory,
          news_type: newsType,
          embedding_generated: true,
          embedding_model: VOYAGEAI_MODEL,
          table_name: 'news',
          word_count: wordCount
        },
        word_count: wordCount,
        language: 'en'
      };

      const documentId = await this.storeNews(newsData, embedding);
      logger.info(`Successfully stored content: ${documentId} - ${fullContent.title}`);

      return { processed: true, isDuplicate: false };

    } catch (error) {
      logger.error(`Failed to process article "${article.title}":`, error);
      return { processed: false, isDuplicate: false };
    }
  }

  // Main processing method
  async processArcherSpecificData(): Promise<any> {
    logger.info('Processing Archer Aviation specific data...');
    
    try {
      await this.initializeNewsBrowser();
      
      logger.info(`\n=== Processing all Archer news (All tab) ===`);
      logger.info(`Navigating to Archer news page: ${this.NEWS_BASE_URL}`);
      
      let navigationSuccess = false;
      let retries = 3;
      
      while (retries > 0 && !navigationSuccess) {
        try {
          await this.newsPage!.goto(this.NEWS_BASE_URL);
          navigationSuccess = true;
          logger.info('Successfully navigated to Archer news page');
        } catch (error) {
          retries--;
          logger.warn(`Navigation failed, retries remaining: ${retries}`, error);
          if (retries > 0) {
            await this.delay(3000);
          } else {
            throw error;
          }
        }
      }
      
      try {
        await this.newsPage!.waitForSelector('#news_content', { timeout: 15000 });
      } catch {}
      
      await this.delay(2000);
      
      await this.loadAllNewsArticles();

      const articles = await this.extractNewsArticles('All');
      logger.info(`Found ${articles.length} total articles`);
      
      // Initialize duplicate tracker for early stopping
      const duplicateTracker = new DuplicateTracker(5, 'news');
      
      let processedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      const allProcessedDocuments = [];
      let stoppedEarly = false;
      
      for (const article of articles) {
        try {
          logger.info(`Processing: ${article.title}`);
          
          const result = await this.processAndStoreArticle(article, duplicateTracker);
          
          // Check if we should stop early
          if (duplicateTracker.shouldStop()) {
            logger.info(`Stopping early: Reached 5 consecutive duplicates. No more new articles to process.`);
            stoppedEarly = true;
            break;
          }
          
          if (result.processed) {
            processedCount++;
            allProcessedDocuments.push({
              url: article.url,
              title: article.title,
              category: article.category
            });
          } else {
            skippedCount++;
          }
          
          await this.delay(3000);
          
        } catch (error) {
          logger.error(`Failed to process article: ${article.title}`, error);
          failedCount++;
        }
      }
      
      if (stoppedEarly) {
        logger.info(`Early stop: Processed ${processedCount} new articles before hitting duplicate threshold.`);
      }
      
      await this.cleanupNewsBrowser();
      
      const archerSummary = {
        success: processedCount > 0,
        company: 'Archer Aviation',
        aircraft: ['Midnight'],
        totalDocuments: allProcessedDocuments.length,
        totalArticles: articles.length,
        processed: processedCount,
        skipped: skippedCount,
        failed: failedCount,
        stoppedEarly: stoppedEarly,
        consecutiveDuplicates: duplicateTracker.getConsecutiveCount(),
        documents: allProcessedDocuments
      };

      logger.info(`\n=== Archer Aviation processing complete ===`);
      logger.info(`Total Articles: ${articles.length}`);
      logger.info(`Processed: ${processedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
      
      return archerSummary;

    } catch (error) {
      logger.error('Failed to process Archer Aviation data:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const archerAviationService = new ArcherAviationService();

