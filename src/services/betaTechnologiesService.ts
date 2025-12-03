import puppeteer, { Browser, Page } from 'puppeteer';
import { convert } from 'html-to-text';
import { supabase } from '../config/database';
import { voyageai, VOYAGEAI_MODEL } from '../config/embedding';
import logger from '../utils/logger';
import { DuplicateTracker } from '../utils/duplicateTracker';

interface CrawledContent {
  title: string;
  h1: string;
  content: string;
  rawHtml: string;
  metaDescription: string;
  images: Array<{
    src: string;
    alt: string;
    title: string;
  }>;
  wordCount: number;
  url: string;
}

export class BetaTechnologiesService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly COMPANY_NAME = 'Beta Technologies';
  private readonly COMPANY_ID = 'beta-technologies';
  private readonly AIRCRAFT = ['ALIA eVTOL', 'CX300 eCTOL'];
  private duplicateTracker: DuplicateTracker;

  private readonly URLs = [
    'https://beta.team/aircraft',
    'https://beta.team/charge',
    'https://beta.team/motor',
    'https://beta.team/battery',
    'https://beta.team/flight-control-computers',
    'https://beta.team/flight-training',
    'https://beta.team/stories',
  ];

  constructor() {
    this.duplicateTracker = new DuplicateTracker(5, 'news');
  }

  // Helper: Delay function
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper: Check if record exists
  private async recordExists(url: string, tableName: string): Promise<boolean> {
    try {
      const { count } = await supabase
        .from(tableName)
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
          await this.delay(2000); // Initial delay to respect rate limits
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
          }
        }
        
        if (attempt >= maxRetries) {
          logger.error('Failed to generate embedding after all retries:', error);
          return [];
        }
      }
    }
    
    return [];
  }

  // Helper: Categorize content
  private categorizeContent(content: string): { category: string; confidence: number } {
    const aircraftKeywords = [
      'aircraft', 'airplane', 'plane', 'helicopter', 'evtol', 'vtol', 'drone', 'uav', 'uas',
      'specification', 'specs', 'performance', 'range', 'speed', 'capacity', 'altitude',
      'propulsion', 'powerplant', 'engine', 'motor', 'electric motor', 'battery',
      'flight', 'aviation', 'aerodynamics', 'lift', 'drag', 'thrust', 'weight'
    ];

    const companyKeywords = [
      'company', 'corporation', 'corp', 'inc', 'llc', 'ltd', 'limited', 'startup',
      'founded', 'established', 'incorporated', 'launched', 'created', 'formed',
      'ceo', 'chief executive officer', 'president', 'chairman', 'executive',
      'leadership', 'management', 'team', 'staff', 'employees', 'workforce'
    ];

    const newsKeywords = [
      'news', 'announcement', 'press release', 'update', 'development', 'progress',
      'partnership', 'collaboration', 'investment', 'funding', 'milestone',
      'certification', 'approval', 'launch', 'delivery', 'order', 'purchase'
    ];

    const pilotTrainingKeywords = [
      'pilot', 'training', 'certification', 'license', 'flight school', 'instructor',
      'simulator', 'ground school', 'flight training', 'aviation training',
      'faa', 'easa', 'regulations', 'safety', 'procedures', 'protocols'
    ];

    const contentLower = content.toLowerCase();
    
    const aircraftScore = aircraftKeywords.reduce((score, keyword) => 
      score + (contentLower.includes(keyword) ? 1 : 0), 0);
    
    const companyScore = companyKeywords.reduce((score, keyword) => 
      score + (contentLower.includes(keyword) ? 1 : 0), 0);
    
    const newsScore = newsKeywords.reduce((score, keyword) => 
      score + (contentLower.includes(keyword) ? 1 : 0), 0);
    
    const pilotTrainingScore = pilotTrainingKeywords.reduce((score, keyword) => 
      score + (contentLower.includes(keyword) ? 1 : 0), 0);

    const scores = {
      aircraft_info: aircraftScore,
      company_info: companyScore,
      news: newsScore,
      pilot_training: pilotTrainingScore
    };

    const maxScore = Math.max(...Object.values(scores));
    const primaryCategory = Object.keys(scores).find(key => scores[key as keyof typeof scores] === maxScore) || 'news';

    return {
      category: primaryCategory,
      confidence: maxScore / Math.max(content.split(' ').length / 100, 1)
    };
  }

  // Initialize browser
  private async initializeBrowser(): Promise<void> {
    try {
      logger.info('Initializing Beta Technologies browser...');
      
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1920, height: 1080 });
      this.page.setDefaultNavigationTimeout(120000); // 120 seconds
      this.page.setDefaultTimeout(120000); // 120 seconds for all operations
      
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      
      logger.info('Browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  // Cleanup browser
  private async cleanupBrowser(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      logger.info('Browser closed successfully');
    } catch (error) {
      logger.error('Error during browser cleanup:', error);
    }
  }

  // Clean extracted content
  private cleanExtractedContent(htmlContent: string): string {
    try {
      const options = {
        wordwrap: 0,
        selectors: [
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'nav', format: 'skip' },
          { selector: 'footer', format: 'skip' },
          { selector: 'header', format: 'skip' },
          { selector: '[class*="cookie"]', format: 'skip' },
          { selector: '[id*="cookie"]', format: 'skip' },
          { selector: '[class*="privacy"]', format: 'skip' },
          { selector: '[id*="privacy"]', format: 'skip' },
          { selector: '[class*="consent"]', format: 'skip' },
          { selector: '[id*="consent"]', format: 'skip' },
          { selector: 'h1', options: { uppercase: false } },
          { selector: 'h2', options: { uppercase: false } },
          { selector: 'h3', options: { uppercase: false } },
          { selector: 'p', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
          { selector: 'img', format: 'skip' },
          { selector: 'ul', options: { itemPrefix: '• ' } },
          { selector: 'ol', options: { itemPrefix: '1. ' } }
        ]
      };

      let cleanedContent = convert(htmlContent, options);
      
      cleanedContent = cleanedContent
        .replace(/For the best experience, please make sure your browser is up-to-date and javascript is enabled\./gi, '')
        .replace(/This website uses cookies/gi, '')
        .replace(/By continuing to use this site/gi, '')
        .replace(/Cookie Policy/gi, '')
        .replace(/Privacy Policy/gi, '')
        .replace(/Accept All Cookies?/gi, '')
        .replace(/Accept Cookies?/gi, '')
        .replace(/I accept/gi, '')
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();

      return cleanedContent;
    } catch (error) {
      logger.warn('Failed to clean content with html-to-text, using fallback:', error);
      return htmlContent
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Crawl URL with retry logic
  private async crawlUrl(url: string, retries: number = 2): Promise<CrawledContent | null> {
    if (!this.page) {
      await this.initializeBrowser();
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`Retrying crawl for ${url} (attempt ${attempt + 1}/${retries + 1})...`);
          await this.delay(5000 * attempt); // Exponential backoff
        } else {
          logger.info(`Crawling ${url} for ${this.COMPANY_NAME}...`);
        }
        
        // Try networkidle2 first, fallback to domcontentloaded if it times out
        let waitStrategy: 'networkidle2' | 'domcontentloaded' = 'networkidle2';
        
        try {
          await this.page!.goto(url, { 
            waitUntil: waitStrategy,
            timeout: 120000 // 120 seconds
          });
        } catch (gotoError: any) {
          // If networkidle2 times out, try with domcontentloaded (less strict)
          if (gotoError?.name === 'TimeoutError' && waitStrategy === 'networkidle2') {
            logger.warn(`networkidle2 timed out for ${url}, trying domcontentloaded...`);
            waitStrategy = 'domcontentloaded';
            await this.page!.goto(url, { 
              waitUntil: waitStrategy,
              timeout: 120000
            });
          } else {
            throw gotoError;
          }
        }

        await this.delay(3000); // Wait for any dynamic content to load

        const content = await this.page!.evaluate(() => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        
        const title = doc.title || doc.querySelector('h1')?.textContent || '';
        const h1 = doc.querySelector('h1')?.textContent || '';
        const mainContent = doc.querySelector('main, article, .content, .post-content, .entry-content') || doc.body;
        const rawHtml = mainContent.innerHTML || '';
        const textContent = mainContent.textContent || '';
        const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        const images = Array.from(doc.querySelectorAll('img')).map((img: any) => ({
          src: img.src || '',
          alt: img.alt || '',
          title: img.title || ''
        }));

          return {
            title,
            h1,
            content: textContent,
            rawHtml,
            metaDescription: metaDesc,
            images,
            wordCount: textContent.split(' ').length,
            url: win.location.href
          };
        });

        content.content = this.cleanExtractedContent(content.rawHtml);

        if (!content.content || content.content.length < 100) {
          logger.warn(`Insufficient content extracted from ${url}`);
          return null;
        }

        logger.info(`Successfully crawled ${url} (${content.wordCount} words)`);
        return content;

      } catch (error: any) {
        const isTimeout = error?.name === 'TimeoutError' || error?.message?.includes('timeout');
        
        if (isTimeout && attempt < retries) {
          logger.warn(`Timeout error for ${url} (attempt ${attempt + 1}/${retries + 1}), will retry...`);
          continue;
        }
        
        if (attempt >= retries) {
          logger.error(`Failed to crawl ${url} after ${retries + 1} attempts:`, error);
          return null;
        }
      }
    }
    
    return null;
  }

  // Store content in database
  private async storeInDatabase(content: CrawledContent, category: string): Promise<{ processed: boolean; isDuplicate: boolean }> {
    try {
      const tableName = category === 'aircraft_info' ? 'aircraft_info' :
                       category === 'company_info' ? 'company_info' :
                       category === 'pilot_training' ? 'pilot_training' : 'news';

      const exists = await this.recordExists(content.url, tableName);
      
      if (exists) {
        logger.info(`Document already exists for URL: ${content.url}`);
        return { processed: false, isDuplicate: true };
      }

      const embedding = await this.generateEmbedding(content.content);
      
      const documentData = {
        title: content.title,
        content: content.content,
        url: content.url,
        source: this.COMPANY_NAME,
        word_count: content.wordCount,
        metadata: {
          h1: content.h1,
          meta_description: content.metaDescription,
          images: content.images,
          company_id: this.COMPANY_ID,
          aircraft_type: this.AIRCRAFT.join(', '),
          embedding_generated: !!embedding,
          embedding_model: VOYAGEAI_MODEL,
          crawled_at: new Date().toISOString()
        },
        embedding: embedding
      };

      const { error } = await supabase
        .from(tableName)
        .upsert(documentData, { 
          onConflict: 'url',
          ignoreDuplicates: false 
        })
        .select()
        .single();

      if (error) {
        logger.error(`Failed to store document in ${tableName}:`, error);
        return { processed: false, isDuplicate: false };
      }

      logger.info(`Successfully stored/updated document in ${tableName} table`);
      return { processed: true, isDuplicate: false };

    } catch (error) {
      logger.error('Failed to store document in database:', error);
      return { processed: false, isDuplicate: false };
    }
  }

  // Process and store article
  private async processAndStoreUrl(url: string): Promise<{ processed: boolean; isDuplicate: boolean }> {
    try {
      const content = await this.crawlUrl(url);
      if (!content) {
        return { processed: false, isDuplicate: false };
      }

      const categorization = this.categorizeContent(content.content);
      const result = await this.storeInDatabase(content, categorization.category);
      
      return result;
    } catch (error) {
      logger.error(`Failed to process URL ${url}:`, error);
      return { processed: false, isDuplicate: false };
    }
  }

  // Main processing method
  async processBetaSpecificData(): Promise<{ processed: number; skipped: number; failed: number }> {
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    try {
      logger.info(`=== Starting ${this.COMPANY_NAME} Service ===`);
      
      await this.initializeBrowser();

      for (const url of this.URLs) {
        try {
          const { isDuplicate } = await this.duplicateTracker.processCheck(url);
          
          if (isDuplicate) {
            skipped++;
            logger.info(`Skipping duplicate URL: ${url}`);
            
            if (this.duplicateTracker.shouldStop()) {
              logger.info(`Stopping early: 5 consecutive duplicates found`);
              break;
            }
            continue;
          }

          const result = await this.processAndStoreUrl(url);
          
          if (result.processed) {
            processed++;
          } else if (result.isDuplicate) {
            skipped++;
          } else {
            failed++;
          }

          await this.delay(2000);

        } catch (error) {
          logger.error(`Error processing URL ${url}:`, error);
          failed++;
        }
      }

      logger.info(`=== ${this.COMPANY_NAME} Service Completed ===`);
      logger.info(`Processed: ${processed}, Skipped: ${skipped}, Failed: ${failed}`);

      return { processed, skipped, failed };

    } catch (error) {
      logger.error(`=== ${this.COMPANY_NAME} Service Failed ===`, error);
      throw error;
    } finally {
      await this.cleanupBrowser();
    }
  }
}

// Export singleton instance
export const betaTechnologiesService = new BetaTechnologiesService();

