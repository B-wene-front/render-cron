import express, { Request, Response } from 'express';
import { jobyAviationService } from './services/jobyAviationService';
import { archerAviationService } from './services/archerAviationService';
import logger from './utils/logger';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_SECRET = process.env.API_SECRET || process.env.SUPABASE_CRON_SECRET;

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: ['joby', 'archer']
  });
});

// Middleware to verify API secret
const verifySecret = (req: Request, res: Response, next: Function) => {
  const providedSecret = req.headers['x-api-secret'] || req.body.secret || req.query.secret;
  
  if (!API_SECRET) {
    logger.warn('API_SECRET not configured - allowing all requests (not recommended for production)');
    return next();
  }
  
  if (providedSecret !== API_SECRET) {
    logger.warn(`Unauthorized request from ${req.ip}`);
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid API secret' 
    });
  }
  
  next();
};

// Service registry
const SERVICE_REGISTRY: Record<string, { service: any; method: string; name: string }> = {
  'joby': {
    service: jobyAviationService,
    method: 'processJobySpecificData',
    name: 'Joby Aviation'
  },
  'archer': {
    service: archerAviationService,
    method: 'processArcherSpecificData',
    name: 'Archer Aviation'
  },
};

// Generic service endpoint
app.post('/api/run/:service', verifySecret, async (req: Request, res: Response) => {
  const serviceKey = req.params.service.toLowerCase();
  const serviceConfig = SERVICE_REGISTRY[serviceKey];
  
  if (!serviceConfig) {
    return res.status(400).json({
      error: 'Invalid service',
      message: `Unknown service: ${serviceKey}. Available: ${Object.keys(SERVICE_REGISTRY).join(', ')}`,
      availableServices: Object.keys(SERVICE_REGISTRY)
    });
  }
  
  logger.info(`=== ${serviceConfig.name} Service Invoked ===`);
  logger.info(`Request from: ${req.ip}`);
  logger.info(`Started at: ${new Date().toISOString()}`);
  
  try {
    const result = await serviceConfig.service[serviceConfig.method]();
    
    logger.info(`=== ${serviceConfig.name} Service Completed ===`);
    logger.info(`Processed: ${result.processed || 0}, Skipped: ${result.skipped || 0}, Failed: ${result.failed || 0}`);
    
    res.json({
      success: true,
      service: serviceConfig.name,
      result: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`=== ${serviceConfig.name} Service Failed ===`, error);
    
    res.status(500).json({
      success: false,
      service: serviceConfig.name,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Run all services endpoint
app.post('/api/run-all', verifySecret, async (req: Request, res: Response) => {
  logger.info('=== All Services Invoked ===');
  logger.info(`Request from: ${req.ip}`);
  logger.info(`Started at: ${new Date().toISOString()}`);
  
  const results: Array<{ service: string; success: boolean; result?: any; error?: string }> = [];
  
  for (const [key, config] of Object.entries(SERVICE_REGISTRY)) {
    try {
      logger.info(`\n=== Processing ${config.name} ===`);
      const result = await config.service[config.method]();
      results.push({ 
        service: config.name, 
        success: true,
        result: result
      });
      logger.info(`${config.name} completed successfully`);
    } catch (error) {
      logger.error(`${config.name} failed:`, error);
      results.push({ 
        service: config.name, 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
    
    // Delay between services
    if (Object.keys(SERVICE_REGISTRY).indexOf(key) < Object.keys(SERVICE_REGISTRY).length - 1) {
      logger.info('Waiting 5 seconds before next service...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  logger.info('\n=== All Services Completed ===');
  const allSuccess = results.every(r => r.success);
  
  res.json({
    success: allSuccess,
    results: results,
    timestamp: new Date().toISOString()
  });
});

// List available services
app.get('/api/services', (req: Request, res: Response) => {
  res.json({
    services: Object.entries(SERVICE_REGISTRY).map(([key, config]) => ({
      key,
      name: config.name,
      endpoint: `/api/run/${key}`
    })),
    allEndpoint: '/api/run-all'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  // Detect if running on Render
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  const isRender = !!renderUrl;
  
  // Build base URL for logging
  let baseUrl: string;
  if (isRender) {
    // On Render, use the provided external URL
    baseUrl = renderUrl;
  } else {
    // Local development - use localhost
    baseUrl = `http://localhost:${PORT}`;
  }
  
  logger.info(`🚀 EVTOL News Service running on port ${PORT}`);
  logger.info(`📋 Available services: ${Object.keys(SERVICE_REGISTRY).join(', ')}`);
  logger.info(`🌐 Base URL: ${baseUrl}`);
  logger.info(`🔗 Health check: ${baseUrl}/health`);
  logger.info(`📚 Services list: ${baseUrl}/api/services`);
  logger.info(`🔧 Service endpoints:`);
  Object.keys(SERVICE_REGISTRY).forEach(service => {
    logger.info(`   POST ${baseUrl}/api/run/${service}`);
  });
  logger.info(`   POST ${baseUrl}/api/run-all`);
  
  if (API_SECRET) {
    logger.info(`🔐 API Secret: Configured`);
  } else {
    logger.warn(`⚠️  API Secret: NOT configured (allowing all requests)`);
  }
});

