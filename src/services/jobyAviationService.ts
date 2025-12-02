import puppeteer, { Browser, Page } from 'puppeteer';
import { parse } from 'node-html-parser';
import { convert } from 'html-to-text';
import { supabase } from '../config/database';
import { voyageai, VOYAGEAI_MODEL } from '../config/embedding';
import logger from '../utils/logger';
import { DuplicateTracker } from '../utils/duplicateTracker';

interface JobyNewsArticle {
  url: string;
  title: string;
  publishedDate: string;
  category: string;
  imageUrl?: string;
}

interface JobyNewsContent {
  title: string;
  publishedDate: string;
  content: string;
  author?: string;
  contactEmail?: string;
  relatedArticles?: string[];
  tags?: string[];
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

export class JobyAviationService {
  private newsBrowser: Browser | null = null;
  private newsPage: Page | null = null;
  private readonly NEWS_BASE_URL = 'https://www.jobyaviation.com/news/';
  private readonly COMPANY_NAME = 'Joby Aviation';

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
    const positiveWords = ['success', 'achievement', 'milestone', 'demonstration', 'partnership', 'innovation', 'breakthrough'];
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
    const highImpactWords = ['major', 'significant', 'milestone', 'historic', 'breakthrough', 'partnership'];
    const highImpactCount = highImpactWords.filter(word => lowerContent.includes(word)).length;

    if (highImpactCount >= 2) return 'high';
    if (highImpactCount === 1) return 'medium';
    return 'low';
  }

  // Helper: Extract geographic focus
  private extractGeographicFocus(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const locations: string[] = [];

    if (lowerContent.includes('japan') || lowerContent.includes('osaka')) locations.push('Japan');
    if (lowerContent.includes('california') || lowerContent.includes('salinas')) locations.push('United States');
    if (lowerContent.includes('dubai') || lowerContent.includes('uae')) locations.push('United Arab Emirates');
    if (lowerContent.includes('korea')) locations.push('South Korea');
    if (lowerContent.includes('new york')) locations.push('United States');
    if (lowerContent.includes('ras al khaimah')) locations.push('United Arab Emirates');

    return [...new Set(locations)];
  }

  // Helper: Extract related companies
  private extractRelatedCompanies(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const companies: string[] = ['Joby Aviation'];

    if (lowerContent.includes('ana holdings') || lowerContent.includes('ana')) companies.push('ANA Holdings');
    if (lowerContent.includes('toyota')) companies.push('Toyota');
    if (lowerContent.includes('blade')) companies.push('Blade Urban Air Mobility');
    if (lowerContent.includes('skyports')) companies.push('Skyports');
    if (lowerContent.includes('rakta')) companies.push('RAKTA');
    if (lowerContent.includes('uber')) companies.push('Uber');
    if (lowerContent.includes('delta')) companies.push('Delta Air Lines');

    return [...new Set(companies)];
  }

  // Helper: Generate tags
  private generateTags(content: string): string[] {
    const tags: string[] = [];
    const lowerContent = content.toLowerCase();
    
    const tagMappings = [
      { keywords: ['air taxi', 'air taxi service'], tag: 'air taxi' },
      { keywords: ['evtol', 'e-vtol'], tag: 'eVTOL' },
      { keywords: ['electric aircraft', 'electric aviation'], tag: 'electric aircraft' },
      { keywords: ['faa', 'federal aviation administration'], tag: 'FAA certification' },
      { keywords: ['demonstration', 'flight demonstration', 'test flight'], tag: 'flight demonstration' },
      { keywords: ['partnership', 'collaboration', 'agreement'], tag: 'partnership' },
      { keywords: ['vertiport', 'vertical port'], tag: 'vertiport' },
      { keywords: ['urban air mobility', 'uam'], tag: 'urban air mobility' },
      { keywords: ['autonomous', 'autopilot'], tag: 'autonomous flight' },
      { keywords: ['sustainability', 'sustainable', 'zero emissions'], tag: 'sustainability' },
      { keywords: ['safety', 'safety features'], tag: 'safety' },
      { keywords: ['regulatory', 'certification'], tag: 'regulatory' },
      { keywords: ['investment', 'funding', 'financing'], tag: 'investment' },
      { keywords: ['manufacturing', 'production'], tag: 'manufacturing' },
      { keywords: ['commercial service', 'commercial operation'], tag: 'commercial service' }
    ];

    for (const mapping of tagMappings) {
      if (mapping.keywords.some(keyword => lowerContent.includes(keyword))) {
        tags.push(mapping.tag);
      }
    }

    return tags;
  }

  // Initialize browser for news crawling
  private async initializeNewsBrowser(): Promise<void> {
    try {
      logger.info('Initializing Joby News browser...');
      
      this.newsBrowser = await puppeteer.launch({
        headless: true, // Use headless for production
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      });

      this.newsPage = await this.newsBrowser.newPage();
      await this.newsPage.setViewport({ width: 1920, height: 1080 });
      this.newsPage.setDefaultNavigationTimeout(120000);
      
      await this.newsPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      
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

  // Handle cookie consent for news pages
  private async handleNewsCookieConsent(): Promise<void> {
    try {
      if (!this.newsPage) return;

      await this.delay(1500); // Wait for cookie banner to appear

      const acceptClicked = await this.newsPage.evaluate(() => {
        // @ts-ignore - browser context
        const buttons = Array.from(document.querySelectorAll('button'));
        const acceptBtn = buttons.find((btn: any) => btn.textContent?.includes('I accept'));
        if (acceptBtn) {
          (acceptBtn as any).click();
          return true;
        }
        return false;
      });
      
      if (acceptClicked) {
        logger.info('Clicked cookie consent');
        await this.delay(1000); // Wait for consent to process
      }
    } catch (error) {
      logger.debug('No cookie consent found or already accepted');
    }
  }

  // Select news category tab
  private async selectNewsCategory(category: 'press-releases' | 'blog-posts' | 'media-coverage'): Promise<void> {
    try {
      let buttonText = '';

      switch (category) {
        case 'press-releases':
          buttonText = 'Press Releases';
          break;
        case 'blog-posts':
          buttonText = 'Blog Posts';
          break;
        case 'media-coverage':
          buttonText = 'Media Coverage';
          break;
      }

      logger.info(`Clicking on ${buttonText} tab...`);
      await this.delay(2000);
      
      const clicked = await this.newsPage!.evaluate((text) => {
        // @ts-ignore - browser context
        const buttons = Array.from(document.querySelectorAll('button'));
        const targetButton = buttons.find((btn: any) => btn.textContent?.includes(text)) as any;
        
        if (targetButton) {
          if (targetButton.classList.contains('border-blue')) {
            return 'already-active';
          }
          targetButton.click();
          return 'clicked';
        }
        return 'not-found';
      }, buttonText);
      
      if (clicked === 'already-active') {
        logger.info(`${buttonText} tab is already active, skipping click`);
      } else if (clicked === 'clicked') {
        await this.delay(3000);
        logger.info(`${buttonText} tab clicked successfully`);
      } else {
        logger.warn(`${buttonText} tab not found, proceeding with current view`);
      }
    } catch (error) {
      logger.error(`Failed to select category ${category}:`, error);
      throw error;
    }
  }

  // Load all news articles by clicking "Load More" until it disappears
  private async loadAllNewsArticles(category?: 'press-releases' | 'blog-posts' | 'media-coverage'): Promise<void> {
    let loadMoreAttempts = 0;
    const maxLoadMoreAttempts = category === 'blog-posts' ? 100 : 1;
    
    while (loadMoreAttempts < maxLoadMoreAttempts) {
      try {
        await this.delay(2000);
        
        const loadMoreButton = await this.newsPage!.evaluate(() => {
          // @ts-ignore - browser context
          const buttons = Array.from(document.querySelectorAll('button.CosmicButton, button'));
          const loadMoreBtn = buttons.find((btn: any) => btn.textContent?.includes('Load More')) as any;
          if (loadMoreBtn) {
            loadMoreBtn.setAttribute('data-load-more', 'true');
            return true;
          }
          return false;
        });
        
        if (!loadMoreButton) {
          logger.info('No "Load More" button found - all articles loaded');
          break;
        }

        logger.info(`Clicking "Load More" button (attempt ${loadMoreAttempts + 1})...`);
        
        await this.newsPage!.evaluate(() => {
          // @ts-ignore - browser context
          const button = document.querySelector('[data-load-more="true"]') as any;
          if (button) {
            button.click();
          }
        });
        
        await this.delay(4000);
        loadMoreAttempts++;
        
      } catch (error) {
        logger.error(`Error during Load More attempt ${loadMoreAttempts + 1}:`, error);
        break;
      }
    }

    logger.info(`Completed loading articles after ${loadMoreAttempts} "Load More" clicks`);
  }

  // Extract news articles from the page
  private async extractNewsArticles(category: string): Promise<JobyNewsArticle[]> {
    const articles = await this.newsPage!.evaluate((cat): JobyNewsArticle[] => {
      // @ts-ignore - document is available in browser context
      const doc = document;
      
      const selectors = [
        'a[href^="/news/"]',
        'a[href^="/blog/"]',
        '.index-item a',
        '.w-full.index-item a',
        'article a',
        '[class*="index-item"] a'
      ];
      
      const articleLinks = new Set<any>();
      selectors.forEach(selector => {
        try {
          doc.querySelectorAll(selector).forEach((el: any) => {
            const href = el.getAttribute('href');
            const isNews = href && href.startsWith('/news/') && href !== '/news/';
            const isBlog = href && href.startsWith('/blog/') && href !== '/blog/';
            if (isNews || isBlog) {
              articleLinks.add(el);
            }
          });
        } catch (e) {
          // Ignore selector errors
        }
      });

      const articles: JobyNewsArticle[] = [];

      articleLinks.forEach((anchor: any) => {
        const href = anchor.getAttribute('href');
        const isValidNews = href && href.startsWith('/news/') && href !== '/news/';
        const isValidBlog = href && href.startsWith('/blog/') && href !== '/blog/';
        
        if (isValidNews || isValidBlog) {
          let title = '';
          const titleSelectors = ['h4', 'h3', 'h2', '.text-xl', '.text-lg', '[class*="text-"]'];
          for (const sel of titleSelectors) {
            const titleElement = anchor.querySelector(sel);
            if (titleElement) {
              title = titleElement.textContent?.trim() || '';
              if (title && title.length > 5) break;
            }
          }
          
          let publishedDate = '';
          const dateSelectors = [
            '.text-xs.font-bold',
            '.text-xs',
            '[class*="date"]',
            '[class*="uppercase"]',
            'time'
          ];
          for (const sel of dateSelectors) {
            const dateElement = anchor.querySelector(sel);
            if (dateElement) {
              publishedDate = dateElement.textContent?.trim() || '';
              if (publishedDate && publishedDate.length > 3) break;
            }
          }
          
          const imageElement = anchor.querySelector('img');
          const imageUrl = imageElement?.getAttribute('src') || undefined;

          if (title) {
            articles.push({
              url: `https://www.jobyaviation.com${href}`,
              title,
              publishedDate: publishedDate || 'Unknown',
              category: cat,
              imageUrl
            });
          }
        }
      });

      // Remove duplicates based on URL
      const uniqueArticles = articles.filter((article, index, self) => 
        index === self.findIndex(a => a.url === article.url)
      );

      return uniqueArticles;
    }, category);

    logger.info(`Extracted ${articles.length} unique articles from category: ${category}`);
    
    if (articles.length > 0) {
      logger.info(`Sample article: ${articles[0].title} - ${articles[0].url}`);
    }
    
    return articles;
  }

  // Fetch detailed content from a single news article page directly
  async fetchArticleContentDirect(url: string): Promise<JobyNewsContent | null> {
    try {
      if (!this.newsPage) {
        await this.initializeNewsBrowser();
      }

      logger.info(`Fetching content directly from: ${url}`);
      await this.newsPage!.goto(url);

      await this.handleNewsCookieConsent();

      // Wait for main content
      try {
        await this.newsPage!.locator('div.rich-text, .rich-text, .transition.rich-text, .w-full.mx-auto.max-w-article .rich-text')
          .setTimeout(15000)
          .wait();
        logger.debug('Rich-text content container found, page loaded');
      } catch (error) {
        logger.warn('Rich-text container not found within timeout, attempting with h1...');
        try {
          await this.newsPage!.locator('h1').setTimeout(8000).wait();
        } catch {}
      }
      
      // Scroll to trigger lazy loading
      try {
        await this.newsPage!.evaluate(async () => {
          // @ts-ignore - window is available in browser context
          await new Promise((resolve: (value: unknown) => void) => {
            const step = () => {
              // @ts-ignore
              const y = window.scrollY;
              // @ts-ignore
              window.scrollBy(0, 600);
              // @ts-ignore
              if (window.scrollY === y) return resolve(null);
              setTimeout(step, 120);
            };
            step();
          });
          // @ts-ignore
          window.scrollTo({ top: 0 });
        });
      } catch {}
      
      await this.delay(1000);

      // Extract data
      let title = '';
      let publishedDate = '';
      let rawHTML = '';
      let contactEmail = 'press@jobyaviation.com';
      let author = '';

      // Extract title
      try {
        const titleLocator = this.newsPage!.locator('h1').setWaitForEnabled(false).setTimeout(5000);
        const titleHandle = await titleLocator.waitHandle();
        title = await titleHandle.evaluate((el: any) => el.textContent?.trim() || '');
        logger.debug(`Title extracted: ${title.substring(0, 50)}...`);
      } catch (error) {
        logger.warn('Could not extract title with h1 locator');
      }

      // Extract published date
      try {
        const dateLocator = this.newsPage!.locator('.text-blue.uppercase, .published-date, .article-date').setWaitForEnabled(false).setTimeout(3000);
        const dateHandle = await dateLocator.waitHandle();
        publishedDate = await dateHandle.evaluate((el: any) => el.textContent?.trim() || '');
        logger.debug(`Date extracted: ${publishedDate}`);
      } catch (error) {
        logger.debug('Could not extract date with class locator');
      }

      // Extract raw HTML content
      const contentSelectors = [
        '#ir-content',
        '.module_body',
        '.module-body',
        '.module_content',
        '.module_content_text',
        '.wysiwyg',
        'div[role="main"]',
        'div.article-body',
        '.w-full.mx-auto.max-w-article .rich-text',
        '.transition.rich-text',
        'div.rich-text',
        '.rich-text',
        '[class*="rich-text"]',
        '.article-content',
        'article',
        'main'
      ];

      for (const selector of contentSelectors) {
        try {
          logger.debug(`Trying content selector: ${selector}`);
          const contentLocator = this.newsPage!.locator(selector).setWaitForEnabled(false).setTimeout(3000);
          const contentHandle = await contentLocator.waitHandle();
          
          rawHTML = await contentHandle.evaluate((el: any) => {
            const cloned = el.cloneNode(true);
            const paragraphs = cloned.querySelectorAll('p');
            paragraphs.forEach((p: any) => {
              const text = p.textContent?.toLowerCase() || '';
              if (text.includes('cookie') && (text.includes('accept') || text.includes('privacy policy'))) {
                p.remove();
              }
            });
            return cloned.innerHTML;
          });
          
          if (rawHTML && rawHTML.length > 50) {
            logger.debug(`Content extracted with '${selector}', length: ${rawHTML.length}`);
            break;
          }
        } catch (error) {
          logger.debug(`Selector '${selector}' not found or failed`);
          continue;
        }
      }

      if (!rawHTML) {
        logger.error('ERROR: No content found with ANY selector! Attempting largest-block fallback...');
        rawHTML = await this.newsPage!.evaluate(() => {
          // @ts-ignore - document is available in browser context
          const candidates = Array.from(document.querySelectorAll(
            '.rich-text, .transition.rich-text, .article-content, article, main, .module_body, .module-body, .module_content, .module_content_text, .wysiwyg, div[role="main"], div.article-body'
          ));
          let bestEl: any = null;
          let bestScore = -1;
          const score = (el: any) => {
            const textLen = (el.textContent || '').trim().length;
            const pCount = el.querySelectorAll('p').length;
            const hCount = el.querySelectorAll('h1,h2,h3').length;
            return textLen + pCount * 50 + hCount * 80;
          };
          for (const el of candidates) {
            const s = score(el);
            if (s > bestScore) {
              bestScore = s;
              bestEl = el;
            }
          }
          if (bestEl) {
            const cloned = bestEl.cloneNode(true);
            cloned.querySelectorAll('p').forEach((p: any) => {
              const t = p.textContent?.toLowerCase() || '';
              if (t.includes('cookie') && (t.includes('accept') || t.includes('privacy policy'))) {
                p.remove();
              }
            });
            return cloned.innerHTML;
          }
          return '';
        });
      }

      if (!title && !rawHTML) {
        logger.warn('No essential data extracted (no title and no content)');
        return null;
      }

      // Parse HTML to clean text
      const root = parse(rawHTML);
      
      const unwantedSelectors = [
        'script', 'style', 'noscript', 'svg', 'figure', 'img', 'button', 
        'nav', 'header', 'footer', 'aside',
        '[id*="cookie"]', '[class*="cookie"]', 
        '[id*="consent"]', '[class*="consent"]',
        '[role="dialog"]',
        '.flex.items-center.my-8',
        '.flex.space-x-16'
      ];
      
      unwantedSelectors.forEach(selector => {
        root.querySelectorAll(selector).forEach(el => el.remove());
      });
      
      const content = root.text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

      const fallbackContent = convert(rawHTML, {
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
      const finalContent = content.length >= 80 ? content : fallbackContent;

      // Extract related articles
      const relatedArticles = await this.newsPage!.evaluate((): string[] => {
        // @ts-ignore - document is available in browser context
        const doc = document;
        const articles: string[] = [];
        const relatedSelectors = [
          '.related-articles a[href^="/news/"], .related-articles a[href^="/blog/"]',
          '.related-posts a[href^="/news/"], .related-posts a[href^="/blog/"]',
          '.similar-articles a[href^="/news/"], .similar-articles a[href^="/blog/"]'
        ];
        for (const selector of relatedSelectors) {
          doc.querySelectorAll(selector).forEach((link: any) => {
            const href = link.getAttribute('href');
            if (href && href !== '/news/' && href !== '/blog/') {
              articles.push(`https://www.jobyaviation.com${href}`);
            }
          });
        }
        return [...new Set(articles)];
      });

      // Generate tags
      const tags = this.generateTags(finalContent);

      return {
        title,
        publishedDate,
        content: finalContent,
        author: author || undefined,
        contactEmail: contactEmail || undefined,
        relatedArticles: relatedArticles.length > 0 ? relatedArticles : undefined,
        tags: tags.length > 0 ? tags : undefined
      };

    } catch (error) {
      logger.error(`Failed to fetch content from ${url}:`, error);
      return null;
    }
  }

  // Parse date from Joby's date format
  private parseJobyDate(dateString: string): Date {
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) {
        return new Date();
      }
      return date;
    } catch {
      return new Date();
    }
  }

  // Process and store content from a direct URL
  async processAndStoreDirectUrl(url: string, category?: string, duplicateTracker?: DuplicateTracker): Promise<{ processed: boolean; isDuplicate: boolean }> {
    try {
      // Use duplicate tracker if provided, otherwise fall back to recordExists
      let isDuplicate = false;
      if (duplicateTracker) {
        const checkResult = await duplicateTracker.processCheck(url);
        isDuplicate = checkResult.isDuplicate;
        if (checkResult.shouldStop) {
          return { processed: false, isDuplicate: true };
        }
      } else {
        isDuplicate = await this.recordExists(url);
      }

      if (isDuplicate) {
        logger.info(`Content already exists, skipping: ${url}`);
        return { processed: false, isDuplicate: true };
      }

      const fullContent = await this.fetchArticleContentDirect(url);
      if (!fullContent) {
        logger.warn(`Failed to fetch content for: ${url}`);
        return { processed: false, isDuplicate: false };
      }

      if (!fullContent.title && !fullContent.content) {
        logger.warn(`No meaningful content found for: ${url}`);
        return { processed: false, isDuplicate: false };
      }

      const wordCount = this.calculateWordCount(fullContent.content);

      // Determine content type
      let articleCategory = 'press_release';
      let newsType = 'press_release';
      
      if (url.includes('/blog/')) {
        articleCategory = 'blog_post';
        newsType = 'blog_post';
      } else if (url.includes('/news/')) {
        const isBlogPost = category === 'blog-posts' || 
                          category === 'blog_posts' ||
                          fullContent.tags?.some(tag => tag.toLowerCase().includes('blog')) || 
                          fullContent.title?.toLowerCase().includes('blog');
        
        if (isBlogPost) {
          articleCategory = 'blog_post';
          newsType = 'blog_post';
        } else {
          articleCategory = 'press_release';
          newsType = 'press_release';
        }
      } else if (url.includes('/about/')) {
        articleCategory = 'company_overview';
        newsType = 'company_overview';
      } else if (url.includes('/careers/')) {
        articleCategory = 'careers';
        newsType = 'announcement';
      } else if (url.includes('ir.jobyaviation.com')) {
        articleCategory = 'investor_relations';
        newsType = 'press_release';
      }

      logger.info(`Generating embedding for: ${fullContent.title || url} (${wordCount} words)`);
      
      if (!fullContent.content || fullContent.content.trim().length === 0) {
        logger.error(`Cannot generate embedding: content is empty for ${url}`);
        return { processed: false, isDuplicate: false };
      }
      
      const embedding = await this.generateEmbedding(fullContent.content);

      const newsData: NewsData = {
        url: url,
        title: fullContent.title || 'Joby Aviation Content',
        content: fullContent.content,
        source: 'joby_aviation',
        published_date: fullContent.publishedDate ? this.parseJobyDate(fullContent.publishedDate) : new Date(),
        news_type: newsType,
        article_category: articleCategory,
        company_name: this.COMPANY_NAME,
        author: fullContent.author,
        publication: 'Joby Aviation',
        tags: fullContent.tags || [],
        sentiment: this.analyzeSentiment(fullContent.content),
        impact_level: this.assessImpactLevel(fullContent.content),
        credibility_score: 0.95,
        geographic_focus: this.extractGeographicFocus(fullContent.content),
        industry_focus: ['eVTOL', 'Urban Air Mobility', 'Aviation', 'Electric Aircraft'],
        related_companies: this.extractRelatedCompanies(fullContent.content),
        press_contact: fullContent.contactEmail ? { email: fullContent.contactEmail } : undefined,
        metadata: {
          snippet: fullContent.title || url,
          published_date: fullContent.publishedDate,
          source: 'joby_aviation',
          url: url,
          author: fullContent.author,
          category: articleCategory,
          news_type: newsType,
          tags: fullContent.tags,
          embedding_generated: true,
          embedding_model: VOYAGEAI_MODEL,
          table_name: 'news',
          word_count: wordCount,
          related_articles: fullContent.relatedArticles
        },
        word_count: wordCount,
        language: 'en'
      };

      const documentId = await this.storeNews(newsData, embedding);
      logger.info(`Successfully stored content: ${documentId} - ${fullContent.title || url}`);

      return { processed: true, isDuplicate: false };

    } catch (error) {
      logger.error(`Failed to process URL "${url}":`, error);
      return { processed: false, isDuplicate: false };
    }
  }

  // Process and store a single news article
  async processAndStoreArticle(article: JobyNewsArticle, duplicateTracker?: DuplicateTracker): Promise<{ processed: boolean; isDuplicate: boolean }> {
    return this.processAndStoreDirectUrl(article.url, article.category, duplicateTracker);
  }

  // Fetch all news article links from the news page
  async fetchAllNewsLinks(category: 'press-releases' | 'blog-posts' | 'media-coverage' = 'press-releases'): Promise<JobyNewsArticle[]> {
    try {
      if (!this.newsPage) {
        await this.initializeNewsBrowser();
      }

      logger.info(`Navigating to Joby news page: ${this.NEWS_BASE_URL}`);
      await this.newsPage!.goto(this.NEWS_BASE_URL);

      await this.handleNewsCookieConsent();
      
      try {
        await this.newsPage!.waitForSelector('.grid, article, main', { timeout: 10000 });
      } catch {}
      
      await this.delay(1000);
      
      await this.selectNewsCategory(category);
      await this.loadAllNewsArticles(category);
      const articles = await this.extractNewsArticles(category);

      logger.info(`Found ${articles.length} news articles in category: ${category}`);
      return articles;

    } catch (error) {
      logger.error('Failed to fetch news links:', error);
      throw error;
    }
  }

  // Main processing method
  async processJobySpecificData(): Promise<any> {
    logger.info('Processing Joby Aviation specific data...');
    
    try {
      await this.initializeNewsBrowser();
      
      const categories: Array<'press-releases' | 'blog-posts'> = ['press-releases', 'blog-posts'];
      const categoryResults = [];
      
      // Initialize duplicate tracker for early stopping (shared across categories)
      const duplicateTracker = new DuplicateTracker(5, 'news_duplicate');
      
      let totalProcessed = 0;
      let totalSkipped = 0;
      let totalFailed = 0;
      const allProcessedDocuments = [];
      let stoppedEarly = false;
      
      // Process each category sequentially
      for (const category of categories) {
        // Reset tracker for each category (optional - you can keep it shared if preferred)
        // duplicateTracker.reset();
        
        logger.info(`\n=== Processing category: ${category} ===`);
        
        logger.info(`Navigating to Joby news page: ${this.NEWS_BASE_URL}`);
        await this.newsPage!.goto(this.NEWS_BASE_URL);
        await this.handleNewsCookieConsent();
        
        try {
          await this.newsPage!.waitForSelector('.grid, article, main', { timeout: 10000 });
        } catch {}
        
        await this.delay(1000);
        
        await this.selectNewsCategory(category);
        await this.loadAllNewsArticles(category);

        const articles = await this.extractNewsArticles(category);
        logger.info(`Found ${articles.length} articles in ${category}`);
        
        let processedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        
        // Process each article
        for (const article of articles) {
          try {
            logger.info(`[${category}] Processing: ${article.title}`);
            
            const result = await this.processAndStoreArticle(article, duplicateTracker);
            
            // Check if we should stop early
            if (duplicateTracker.shouldStop()) {
              logger.info(`Stopping early in category ${category}: Reached 5 consecutive duplicates. No more new articles to process.`);
              stoppedEarly = true;
              break;
            }
            
            if (result.processed) {
              processedCount++;
              allProcessedDocuments.push({
                url: article.url,
                title: article.title,
                category: category,
                publishedDate: article.publishedDate
              });
            } else {
              skippedCount++;
            }
            
            await this.delay(2000);
            
          } catch (error) {
            logger.error(`Failed to process article: ${article.title}`, error);
            failedCount++;
          }
        }
        
        if (stoppedEarly) {
          logger.info(`Early stop in category ${category}: Processed ${processedCount} new articles before hitting duplicate threshold.`);
          // Break out of category loop if stopped early
          break;
        }
        
        categoryResults.push({
          category,
          total: articles.length,
          processed: processedCount,
          skipped: skippedCount,
          failed: failedCount
        });
        
        totalProcessed += processedCount;
        totalSkipped += skippedCount;
        totalFailed += failedCount;
        
        logger.info(`${category} complete: ${processedCount} processed, ${skippedCount} skipped, ${failedCount} failed`);
      }
      
      await this.cleanupNewsBrowser();
      
      const jobySummary = {
        success: totalProcessed > 0,
        company: 'Joby Aviation',
        aircraft: ['S4 Electric Air Taxi'],
        totalDocuments: allProcessedDocuments.length,
        processed: totalProcessed,
        skipped: totalSkipped,
        failed: totalFailed,
        stoppedEarly: stoppedEarly,
        consecutiveDuplicates: duplicateTracker.getConsecutiveCount(),
        categoryResults,
        documents: allProcessedDocuments
      };

      logger.info(`\n=== Joby Aviation processing complete ===`);
      logger.info(`Total: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalFailed} failed`);
      categoryResults.forEach(result => {
        logger.info(`  ${result.category}: ${result.processed}/${result.total} processed`);
      });
      
      return jobySummary;

    } catch (error) {
      logger.error('Failed to process Joby Aviation data:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const jobyAviationService = new JobyAviationService();

