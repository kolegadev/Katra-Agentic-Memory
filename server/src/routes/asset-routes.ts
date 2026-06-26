/**
 * S3 Asset Management API Routes
 * 
 * Provides endpoints for uploading, downloading, and managing assets in S3 storage.
 * Integrates with the polyglot persistence architecture for optimal performance.
 */

import { Hono } from 'hono';
import { s3_asset_service } from '../services/infrastructure/s3-asset-service.js';
import { get_database } from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { generateContentHash } from '../services/infrastructure/content-hash-utils.js';
import { validateKatraKey } from '../utils/api-key-manager.js';
import { DEFAULT_USER_ID } from '../services/memory/memory-scope-service.js';

/**
 * Create asset management routes
 */
export function create_assets_routes(): Hono {
    const router = new Hono();

    // Auth middleware — require valid API key
    router.use('*', async (c, next) => {
        const authHeader = c.req.header('Authorization') ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        const queryToken = c.req.query('token') ?? '';
        const tokenToValidate = token || queryToken;
        if (!validateKatraKey(tokenToValidate)) {
            return c.json({ error: 'Unauthorized', message: 'API key required' }, 401);
        }
        return next();
    });

    /**
     * POST /upload-url - Get signed URL for direct browser upload
     */
    router.post('/upload-url', async (c) => {
        try {
            const body = await c.req.json();
            const { filename, content_type, session_id, tags, lifecycle_days } = body;
            
            if (!filename || !content_type) {
                return c.json({
                    success: false,
                    error: 'filename and content_type are required'
                }, 400);
            }

            const upload_data = await s3_asset_service.get_upload_url(
                filename,
                content_type,
                {
                    user_id: DEFAULT_USER_ID,
                    session_id,
                    tags,
                    lifecycle_days
                }
            );
            
            return c.json({
                success: true,
                data: upload_data
            });
        } catch (error) {
            console.error('❌ Failed to generate upload URL:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to generate upload URL'
            }, 500);
        }
    });

    /**
     * GET /:asset_id/download - Get signed download URL for asset
     */
    router.get('/:asset_id/download', async (c) => {
        try {
            const asset_id = c.req.param('asset_id');
            const expires_in = parseInt(c.req.query('expires_in') || '3600');
            
            if (!asset_id) {
                return c.json({
                    success: false,
                    error: 'asset_id parameter is required'
                }, 400);
            }

            const download_data = await s3_asset_service.get_download_url(asset_id, expires_in);
            
            return c.json({
                success: true,
                data: download_data
            });
        } catch (error) {
            console.error('❌ Failed to generate download URL:', error);
            
            if (error instanceof Error && error.message.includes('not found')) {
                return c.json({
                    success: false,
                    error: 'Asset not found'
                }, 404);
            }
            
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to generate download URL'
            }, 500);
        }
    });

    /**
     * GET /browse — List assets with download URLs for the file browser
     * Must be registered BEFORE /:asset_id to avoid wildcard match
     */
    router.get('/browse', async (c) => {
        try {
            const query = c.req.query();
            const user_id = query.user_id || 'demo-user';
            const limit = query.limit ? parseInt(query.limit) : 50;

            const assets_data = await s3_asset_service.list_assets({
                user_id,
                limit,
                sort_by: 'created_at',
                sort_order: 'desc',
            });

            // Generate download URLs for each asset
            const assets_with_urls = await Promise.all(
                assets_data.assets.map(async (asset) => {
                    try {
                        const dl = await s3_asset_service.get_download_url(asset.asset_id, 3600);
                        return { ...asset, download_url: dl.download_url };
                    } catch {
                        return { ...asset, download_url: null };
                    }
                })
            );

            return c.json({
                success: true,
                data: { assets: assets_with_urls, total: assets_data.total_count },
            });
        } catch (error) {
            console.error('❌ Failed to browse assets:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to browse assets'
            }, 500);
        }
    });

    /**
     * GET /:asset_id - Get asset metadata
     */
    router.get('/:asset_id', async (c) => {
        try {
            const asset_id = c.req.param('asset_id');
            
            if (!asset_id) {
                return c.json({
                    success: false,
                    error: 'asset_id parameter is required'
                }, 400);
            }

            // This will throw if asset doesn't exist
            const download_data = await s3_asset_service.get_download_url(asset_id, 1); // 1 second expiry just to get metadata
            
            return c.json({
                success: true,
                data: {
                    metadata: download_data.metadata,
                    cdn_url: download_data.cdn_url
                }
            });
        } catch (error) {
            console.error('❌ Failed to get asset metadata:', error);
            
            if (error instanceof Error && error.message.includes('not found')) {
                return c.json({
                    success: false,
                    error: 'Asset not found'
                }, 404);
            }
            
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get asset metadata'
            }, 500);
        }
    });

    /**
     * POST /:asset_id/download-to-workspace - Download asset from MinIO to /workspace/uploads/
     * This is the bridge that lets the agent access uploaded files on the filesystem.
     */
    router.post('/:asset_id/download-to-workspace', async (c) => {
        try {
            const asset_id = c.req.param('asset_id');
            const subdir = c.req.query('subdir') || '';

            if (!asset_id) {
                return c.json({
                    success: false,
                    error: 'asset_id parameter is required'
                }, 400);
            }

            // Fetch file content from MinIO
            const { buffer, filename } = await s3_asset_service.get_file_content(asset_id);

            // Determine target directory
            const fs = await import('fs');
            const path = await import('path');
            const targetDir = subdir
                ? `/workspace/uploads/${subdir}`
                : '/workspace/uploads';

            // Ensure target directory exists
            fs.mkdirSync(targetDir, { recursive: true });

            // Write the file
            const targetPath = path.join(targetDir, filename);
            fs.writeFileSync(targetPath, buffer);

            console.log(`📥 Asset downloaded to workspace: ${targetPath} (${buffer.length} bytes)`);

            return c.json({
                success: true,
                data: {
                    asset_id,
                    filename,
                    local_path: targetPath,
                    size_bytes: buffer.length,
                    content_type: await (async () => {
                        const meta = await s3_asset_service.get_asset_metadata(asset_id);
                        return meta?.content_type || 'unknown';
                    })(),
                }
            });
        } catch (error) {
            console.error('❌ Failed to download asset to workspace:', error);
            if (error instanceof Error && error.message.includes('not found')) {
                return c.json({
                    success: false,
                    error: 'Asset not found'
                }, 404);
            }
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to download asset to workspace'
            }, 500);
        }
    });

    /**
     * DELETE /:asset_id - Delete asset
     */
    router.delete('/:asset_id', async (c) => {
        try {
            const asset_id = c.req.param('asset_id');
            
            if (!asset_id) {
                return c.json({
                    success: false,
                    error: 'asset_id parameter is required'
                }, 400);
            }

            const deletion_result = await s3_asset_service.delete_asset(asset_id);
            
            return c.json({
                success: true,
                data: {
                    asset_id,
                    deleted_from_s3: deletion_result.deleted,
                    metadata_removed: deletion_result.metadata_removed,
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('❌ Failed to delete asset:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete asset'
            }, 500);
        }
    });

    /**
     * GET / - List assets with filtering and pagination
     */
    router.get('/', async (c) => {
        try {
            const query = c.req.query();
            
            const options = {
                user_id: query.user_id,
                session_id: query.session_id,
                content_type: query.content_type,
                tags: query.tags ? query.tags.split(',') : undefined,
                limit: query.limit ? parseInt(query.limit) : undefined,
                offset: query.offset ? parseInt(query.offset) : undefined,
                sort_by: query.sort_by as 'created_at' | 'last_accessed' | 'file_size' | undefined,
                sort_order: query.sort_order as 'asc' | 'desc' | undefined
            };
            
            const assets_data = await s3_asset_service.list_assets(options);
            
            return c.json({
                success: true,
                data: {
                    ...assets_data,
                    query_options: options,
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('❌ Failed to list assets:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list assets'
            }, 500);
        }
    });

    /**
     * GET /stats/storage - Get storage usage statistics
     */
    router.get('/stats/storage', async (c) => {
        try {
            const storage_stats = await s3_asset_service.get_storage_statistics();
            
            return c.json({
                success: true,
                data: {
                    ...storage_stats,
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('❌ Failed to get storage statistics:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get storage statistics'
            }, 500);
        }
    });

    /**
     * POST /upload-direct - Proxy upload through backend to MinIO
     * Accepts JSON with base64-encoded file data. Avoids CORS and hostname issues
     * with pre-signed URLs when the client is remote.
     */
    router.post('/upload-direct', async (c) => {
        try {
            const body = await c.req.json();
            const { filename, content_type, data, user_id, session_id } = body;

            if (!filename || !data) {
                return c.json({
                    success: false,
                    error: 'filename and data (base64) are required'
                }, 400);
            }

            // Decode base64 to Buffer
            const fileBuffer = Buffer.from(data, 'base64');
            const mimeType = content_type || 'application/octet-stream';

            // Upload to MinIO via existing upload_asset method
            const result = await s3_asset_service.upload_asset(
                fileBuffer,
                filename,
                {
                    content_type: mimeType,
                    user_id,
                    session_id,
                }
            );

            // Store file_upload episodic event for memory recall
            try {
                const db = get_database();
                const userId = user_id || 'demo-user';
                const sessId = session_id || `upload-${Date.now()}`;
                const contentHash = generateContentHash({
                    event_type: 'file_upload',
                    content: { message: `Uploaded file: ${filename} (${(fileBuffer.length / 1024).toFixed(1)} KB, ${mimeType})` },
                    user_id: userId,
                    session_id: sessId,
                });
                await db.collection('episodic_events').insertOne({
                    id: uuidv4(),
                    user_id: userId,
                    session_id: sessId,
                    event_type: 'file_upload',
                    content: {
                        message: `Uploaded file: ${filename} (${(fileBuffer.length / 1024).toFixed(1)} KB, ${mimeType})`,
                        filename,
                        file_size: fileBuffer.length,
                        content_type: mimeType,
                        asset_id: result.asset_id,
                        s3_key: result.s3_key,
                    },
                    content_hash: contentHash,
                    idempotency_key: `${sessId}_file_upload_${contentHash}`,
                    timestamp: new Date(),
                    processed: false,
                });
            } catch (memErr) {
                // Non-fatal: upload succeeded even if episodic event fails
                console.error('⚠️ Failed to store file_upload episodic event:', memErr);
            }

            return c.json({
                success: true,
                data: result
            });
        } catch (error) {
            console.error('❌ Direct upload failed:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Direct upload failed'
            }, 500);
        }
    });

    /**
     * POST /migrate-from-mongodb - Migrate existing assets from MongoDB to S3
     */
    router.post('/migrate-from-mongodb', async (c) => {
        try {
            const body = await c.req.json();
            const { collection_name = 'assets', limit = 100, dry_run = true } = body;
            
            // This would implement migration logic
            return c.json({
                success: false,
                error: 'Asset migration endpoint not yet implemented - will migrate binary data from MongoDB to S3'
            }, 501);
        } catch (error) {
            console.error('❌ Asset migration failed:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Asset migration failed'
            }, 500);
        }
    });

    /**
     * GET /health - Asset service health check
     */
    router.get('/health', async (c) => {
        try {
            // Test S3 connectivity by checking if we can generate a signed URL
            const test_result = await s3_asset_service.get_upload_url(
                'health-check.txt',
                'text/plain',
                { user_id: 'health-check' }
            );
            
            const health_status = {
                status: 'healthy',
                s3_connectivity: true,
                bucket_configured: !!process.env.S3_BUCKET_NAME,
                cdn_enabled: !!process.env.CDN_BASE_URL,
                credentials_configured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
                timestamp: new Date().toISOString()
            };
            
            return c.json({
                success: true,
                data: health_status
            });
        } catch (error) {
            console.error('❌ Asset service health check failed:', error);
            
            const health_status = {
                status: 'unhealthy',
                s3_connectivity: false,
                bucket_configured: !!process.env.S3_BUCKET_NAME,
                cdn_enabled: !!process.env.CDN_BASE_URL,
                credentials_configured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
                error: error instanceof Error ? error.message : 'Unknown error',
                timestamp: new Date().toISOString()
            };
            
            return c.json({
                success: false,
                data: health_status
            }, 503);
        }
    });

    return router;
}