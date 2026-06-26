/**
 * S3 Asset Management Service
 * 
 * Implements S3-compatible object storage for the cognitive memory architecture.
 * Provides secure upload/download, asset lifecycle management, and CDN integration
 * for optimal polyglot persistence.
 */

import { 
    S3Client, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { get_database } from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';

export interface AssetMetadata {
    asset_id: string;
    user_id?: string;
    session_id?: string;
    original_filename?: string;
    content_type: string;
    file_size: number;
    s3_key: string;
    s3_bucket: string;
    s3_url: string;
    cdn_url?: string;
    created_at: Date;
    last_accessed?: Date;
    access_count: number;
    tags?: string[];
    lifecycle_policy?: {
        expires_at?: Date;
        auto_delete: boolean;
    };
}

export interface UploadOptions {
    content_type?: string;
    tags?: string[];
    user_id?: string;
    session_id?: string;
    lifecycle_days?: number;
    public_read?: boolean;
}

export interface MultipartUpload {
    upload_id: string;
    asset_id: string;
    parts: Array<{
        part_number: number;
        etag: string;
    }>;
    total_parts: number;
    expires_at: Date;
}

/**
 * S3 Asset Management Service
 */
export class S3AssetService {
    private s3_client: S3Client;
    private readonly DEFAULT_BUCKET = process.env.S3_BUCKET_NAME || 'cognitive-memory-assets';
    private readonly DEFAULT_REGION = process.env.S3_REGION || 'us-east-1';
    private readonly CDN_BASE_URL = process.env.CDN_BASE_URL;
    private readonly SIGNED_URL_EXPIRY = 3600; // 1 hour
    private readonly MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
    private readonly MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

    constructor() {
        // Initialize S3 client with configuration
        // Supports both standard AWS env vars and legacy/non-standard names
        const access_key_id = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || '';
        const secret_access_key = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY || '';

        if (!access_key_id || !secret_access_key) {
            console.warn('⚠️  AWS credentials incomplete. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY + AWS_SECRET_KEY)');
        }

        const s3_config: any = {
            region: this.DEFAULT_REGION,
            credentials: {
                accessKeyId: access_key_id,
                secretAccessKey: secret_access_key
            }
        };

        // Support custom S3-compatible endpoints (e.g., MinIO, LocalStack)
        if (process.env.S3_ENDPOINT) {
            s3_config.endpoint = process.env.S3_ENDPOINT;
            s3_config.forcePathStyle = true; // Required for some S3-compatible services
        }

        this.s3_client = new S3Client(s3_config);
        
        console.log(`🗄️ S3 Asset Service initialized: bucket=${this.DEFAULT_BUCKET}, region=${this.DEFAULT_REGION}`);
    }

    /**
     * Upload asset to S3 with secure signed URL
     * @param file_buffer File data as Buffer
     * @param filename Original filename
     * @param options Upload options
     * @returns Asset metadata with upload results
     */
    async upload_asset(
        file_buffer: Buffer,
        filename: string,
        options: UploadOptions = {}
    ): Promise<AssetMetadata> {
        const asset_id = uuidv4();
        const file_size = file_buffer.length;
        
        console.log(`📤 Uploading asset: ${filename} (${file_size} bytes)`);
        
        // Validate file size
        if (file_size > this.MAX_FILE_SIZE) {
            throw new Error(`File size ${file_size} exceeds maximum allowed size ${this.MAX_FILE_SIZE}`);
        }
        
        // Generate S3 key with proper structure
        const s3_key = this.generate_s3_key(asset_id, filename, options);
        const content_type = options.content_type || this.infer_content_type(filename);
        
        try {
            let upload_result;
            
            // Use multipart upload for large files
            if (file_size >= this.MULTIPART_THRESHOLD) {
                upload_result = await this.multipart_upload(file_buffer, s3_key, content_type, options);
            } else {
                upload_result = await this.simple_upload(file_buffer, s3_key, content_type, options);
            }
            
            // Generate URLs — use MinIO/local endpoint when configured, else AWS format
            const s3_url = process.env.S3_ENDPOINT
              ? `${process.env.S3_ENDPOINT}/${this.DEFAULT_BUCKET}/${s3_key}`
              : `https://${this.DEFAULT_BUCKET}.s3.${this.DEFAULT_REGION}.amazonaws.com/${s3_key}`;
            const cdn_url = this.CDN_BASE_URL ? `${this.CDN_BASE_URL}/${s3_key}` : undefined;
            
            // Create asset metadata
            const asset_metadata: AssetMetadata = {
                asset_id,
                user_id: options.user_id,
                session_id: options.session_id,
                original_filename: filename,
                content_type,
                file_size,
                s3_key,
                s3_bucket: this.DEFAULT_BUCKET,
                s3_url,
                cdn_url,
                created_at: new Date(),
                access_count: 0,
                tags: options.tags,
                lifecycle_policy: options.lifecycle_days ? {
                    expires_at: new Date(Date.now() + options.lifecycle_days * 24 * 60 * 60 * 1000),
                    auto_delete: true
                } : undefined
            };
            
            // Store metadata in MongoDB
            await this.store_asset_metadata(asset_metadata);
            
            console.log(`✅ Asset uploaded successfully: ${asset_id} (${s3_key})`);
            
            return asset_metadata;
            
        } catch (error) {
            console.error('❌ Asset upload failed:', error);
            throw new Error(`Asset upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Get signed download URL for asset
     * @param asset_id Asset identifier
     * @param expires_in Expiry time in seconds
     * @returns Signed download URL and metadata
     */
    async get_download_url(
        asset_id: string, 
        expires_in: number = this.SIGNED_URL_EXPIRY
    ): Promise<{
        download_url: string;
        cdn_url?: string;
        metadata: AssetMetadata;
        expires_at: Date;
    }> {
        console.log(`🔗 Generating download URL for asset: ${asset_id}`);
        
        // Get asset metadata from MongoDB
        const metadata = await this.get_asset_metadata(asset_id);
        if (!metadata) {
            throw new Error(`Asset not found: ${asset_id}`);
        }
        
        // Update access tracking
        await this.track_asset_access(asset_id);
        
        // Generate signed URL
        const get_object_command = new GetObjectCommand({
            Bucket: metadata.s3_bucket,
            Key: metadata.s3_key
        });
        
        const download_url = await getSignedUrl(this.s3_client, get_object_command, { 
            expiresIn: expires_in 
        });
        
        const expires_at = new Date(Date.now() + expires_in * 1000);
        
        console.log(`✅ Download URL generated for ${asset_id}, expires at ${expires_at.toISOString()}`);
        
        return {
            download_url,
            cdn_url: metadata.cdn_url,
            metadata,
            expires_at
        };
    }

    /**
     * Get signed upload URL for direct browser upload
     * @param filename Original filename
     * @param content_type Content type
     * @param options Upload options
     * @returns Signed upload URL and asset metadata
     */
    async get_upload_url(
        filename: string,
        content_type: string,
        options: UploadOptions = {}
    ): Promise<{
        upload_url: string;
        asset_id: string;
        s3_key: string;
        fields: Record<string, string>;
    }> {
        const asset_id = uuidv4();
        const s3_key = this.generate_s3_key(asset_id, filename, options);
        
        console.log(`🔗 Generating upload URL for: ${filename} (${asset_id})`);
        
        // Create put object command
        const put_object_command = new PutObjectCommand({
            Bucket: this.DEFAULT_BUCKET,
            Key: s3_key,
            ContentType: content_type
        });
        
        // Generate signed URL for PUT operation
        const upload_url = await getSignedUrl(this.s3_client, put_object_command, {
            expiresIn: this.SIGNED_URL_EXPIRY
        });
        
        // Pre-create metadata entry
        const asset_metadata: AssetMetadata = {
            asset_id,
            user_id: options.user_id,
            session_id: options.session_id,
            original_filename: filename,
            content_type,
            file_size: 0, // Will be updated after upload
            s3_key,
            s3_bucket: this.DEFAULT_BUCKET,
            s3_url: process.env.S3_ENDPOINT
              ? `${process.env.S3_ENDPOINT}/${this.DEFAULT_BUCKET}/${s3_key}`
              : `https://${this.DEFAULT_BUCKET}.s3.${this.DEFAULT_REGION}.amazonaws.com/${s3_key}`,
            cdn_url: this.CDN_BASE_URL ? `${this.CDN_BASE_URL}/${s3_key}` : undefined,
            created_at: new Date(),
            access_count: 0,
            tags: options.tags
        };
        
        await this.store_asset_metadata(asset_metadata);
        
        return {
            upload_url,
            asset_id,
            s3_key,
            fields: {
                'Content-Type': content_type,
                'x-amz-meta-asset-id': asset_id,
                'x-amz-meta-user-id': options.user_id || '',
                'x-amz-meta-session-id': options.session_id || ''
            }
        };
    }

    /**
     * Delete asset from S3 and remove metadata
     * @param asset_id Asset identifier
     * @returns Deletion result
     */
    async delete_asset(asset_id: string): Promise<{
        deleted: boolean;
        metadata_removed: boolean;
    }> {
        console.log(`🗑️ Deleting asset: ${asset_id}`);
        
        // Get asset metadata
        const metadata = await this.get_asset_metadata(asset_id);
        if (!metadata) {
            console.log(`⚠️ Asset metadata not found: ${asset_id}`);
            return { deleted: false, metadata_removed: false };
        }
        
        let deleted = false;
        
        try {
            // Delete from S3
            const delete_command = new DeleteObjectCommand({
                Bucket: metadata.s3_bucket,
                Key: metadata.s3_key
            });
            
            await this.s3_client.send(delete_command);
            deleted = true;
            
            console.log(`✅ Asset deleted from S3: ${metadata.s3_key}`);
            
        } catch (error) {
            console.error('❌ Failed to delete asset from S3:', error);
        }
        
        // Remove metadata from MongoDB
        const metadata_removed = await this.remove_asset_metadata(asset_id);
        
        return { deleted, metadata_removed };
    }

    /**
     * List assets with filtering and pagination
     * @param options Filtering options
     * @returns Paginated asset list
     */
    async list_assets(options: {
        user_id?: string;
        session_id?: string;
        content_type?: string;
        tags?: string[];
        limit?: number;
        offset?: number;
        sort_by?: 'created_at' | 'last_accessed' | 'file_size';
        sort_order?: 'asc' | 'desc';
    } = {}): Promise<{
        assets: AssetMetadata[];
        total_count: number;
        has_more: boolean;
    }> {
        console.log('📋 Listing assets with filters:', options);
        
        const db = get_database();
        const limit = Math.min(options.limit || 50, 100);
        const offset = options.offset || 0;
        
        // Build MongoDB filter
        const filter: any = {};
        
        if (options.user_id) filter.user_id = options.user_id;
        if (options.session_id) filter.session_id = options.session_id;
        if (options.content_type) filter.content_type = new RegExp(options.content_type, 'i');
        if (options.tags) filter.tags = { $in: options.tags };
        
        // Build sort criteria
        const sort_field = options.sort_by || 'created_at';
        const sort_direction = options.sort_order === 'asc' ? 1 : -1;
        const sort: Record<string, 1 | -1> = { [sort_field]: sort_direction };
        
        try {
            // Get total count
            const total_count = await db.collection('asset_metadata').countDocuments(filter);
            
            // Get paginated results
            const assets = await db.collection('asset_metadata')
                .find(filter)
                .sort(sort)
                .skip(offset)
                .limit(limit)
                .toArray();
            
            const has_more = (offset + limit) < total_count;
            
            console.log(`✅ Retrieved ${assets.length} assets (${total_count} total)`);
            
            return {
                assets: assets.map(asset => ({
                    asset_id: asset.asset_id,
                    user_id: asset.user_id,
                    session_id: asset.session_id,
                    original_filename: asset.original_filename,
                    content_type: asset.content_type,
                    file_size: asset.file_size,
                    s3_key: asset.s3_key,
                    s3_bucket: asset.s3_bucket,
                    s3_url: asset.s3_url,
                    cdn_url: asset.cdn_url,
                    created_at: asset.created_at,
                    last_accessed: asset.last_accessed,
                    access_count: asset.access_count,
                    tags: asset.tags,
                    lifecycle_policy: asset.lifecycle_policy
                })) as AssetMetadata[],
                total_count,
                has_more
            };
            
        } catch (error) {
            console.error('❌ Failed to list assets:', error);
            return { assets: [], total_count: 0, has_more: false };
        }
    }

    /**
     * Get asset storage statistics
     * @returns Storage usage statistics
     */
    async get_storage_statistics(): Promise<{
        total_assets: number;
        total_size_bytes: number;
        total_size_human: string;
        breakdown_by_type: Record<string, { count: number; size_bytes: number }>;
        recent_uploads: number;
        cdn_enabled: boolean;
    }> {
        console.log('📊 Getting asset storage statistics...');
        
        const db = get_database();
        
        try {
            // Aggregation pipeline for statistics
            const stats_pipeline = [
                {
                    $group: {
                        _id: '$content_type',
                        count: { $sum: 1 },
                        total_size: { $sum: '$file_size' }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total_assets: { $sum: '$count' },
                        total_size_bytes: { $sum: '$total_size' },
                        breakdown: { 
                            $push: { 
                                content_type: '$_id', 
                                count: '$count', 
                                size_bytes: '$total_size' 
                            } 
                        }
                    }
                }
            ];
            
            const results = await db.collection('asset_metadata').aggregate(stats_pipeline).toArray();
            const stats_result = results[0] || { total_assets: 0, total_size_bytes: 0, breakdown: [] };
            
            // Get recent uploads (last 24 hours)
            const recent_uploads = await db.collection('asset_metadata').countDocuments({
                created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            });
            
            // Build breakdown by type
            const breakdown_by_type: Record<string, { count: number; size_bytes: number }> = {};
            stats_result.breakdown.forEach((item: any) => {
                breakdown_by_type[item.content_type || 'unknown'] = {
                    count: item.count,
                    size_bytes: item.size_bytes
                };
            });
            
            return {
                total_assets: stats_result.total_assets,
                total_size_bytes: stats_result.total_size_bytes,
                total_size_human: this.format_bytes(stats_result.total_size_bytes),
                breakdown_by_type,
                recent_uploads,
                cdn_enabled: !!this.CDN_BASE_URL
            };
            
        } catch (error) {
            console.error('❌ Failed to get storage statistics:', error);
            return {
                total_assets: 0,
                total_size_bytes: 0,
                total_size_human: '0 B',
                breakdown_by_type: {},
                recent_uploads: 0,
                cdn_enabled: !!this.CDN_BASE_URL
            };
        }
    }

    // Private helper methods

    private async simple_upload(
        file_buffer: Buffer,
        s3_key: string,
        content_type: string,
        options: UploadOptions
    ): Promise<void> {
        const put_command = new PutObjectCommand({
            Bucket: this.DEFAULT_BUCKET,
            Key: s3_key,
            Body: file_buffer,
            ContentType: content_type,
            Metadata: {
                'asset-id': s3_key.split('/')[0],
                'user-id': options.user_id || '',
                'session-id': options.session_id || '',
                'upload-timestamp': new Date().toISOString()
            }
        });
        
        await this.s3_client.send(put_command);
    }

    private async multipart_upload(
        file_buffer: Buffer,
        s3_key: string,
        content_type: string,
        options: UploadOptions
    ): Promise<void> {
        const create_command = new CreateMultipartUploadCommand({
            Bucket: this.DEFAULT_BUCKET,
            Key: s3_key,
            ContentType: content_type
        });
        
        const create_result = await this.s3_client.send(create_command);
        const upload_id = create_result.UploadId!;
        
        try {
            const part_size = 100 * 1024 * 1024; // 100MB parts
            const parts = [];
            
            for (let i = 0; i < file_buffer.length; i += part_size) {
                const part_number = Math.floor(i / part_size) + 1;
                const end = Math.min(i + part_size, file_buffer.length);
                const part_buffer = file_buffer.slice(i, end);
                
                const upload_part_command = new UploadPartCommand({
                    Bucket: this.DEFAULT_BUCKET,
                    Key: s3_key,
                    PartNumber: part_number,
                    UploadId: upload_id,
                    Body: part_buffer
                });
                
                const part_result = await this.s3_client.send(upload_part_command);
                parts.push({
                    ETag: part_result.ETag!,
                    PartNumber: part_number
                });
                
                console.log(`📤 Uploaded part ${part_number} (${part_buffer.length} bytes)`);
            }
            
            // Complete multipart upload
            const complete_command = new CompleteMultipartUploadCommand({
                Bucket: this.DEFAULT_BUCKET,
                Key: s3_key,
                UploadId: upload_id,
                MultipartUpload: { Parts: parts }
            });
            
            await this.s3_client.send(complete_command);
            console.log(`✅ Multipart upload completed: ${parts.length} parts`);
            
        } catch (error) {
            // Abort multipart upload on error
            const abort_command = new AbortMultipartUploadCommand({
                Bucket: this.DEFAULT_BUCKET,
                Key: s3_key,
                UploadId: upload_id
            });
            
            await this.s3_client.send(abort_command);
            throw error;
        }
    }

    private generate_s3_key(asset_id: string, filename: string, options: UploadOptions): string {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        const file_extension = filename.split('.').pop()?.toLowerCase() || '';
        
        // Structure: year/month/day/asset_id.extension
        return `${year}/${month}/${day}/${asset_id}.${file_extension}`;
    }

    private infer_content_type(filename: string): string {
        const extension = filename.split('.').pop()?.toLowerCase();
        
        const mime_types: Record<string, string> = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'pdf': 'application/pdf',
            'txt': 'text/plain',
            'json': 'application/json',
            'mp4': 'video/mp4',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav',
            'zip': 'application/zip'
        };
        
        return mime_types[extension || ''] || 'application/octet-stream';
    }

    private async store_asset_metadata(metadata: AssetMetadata): Promise<void> {
        const db = get_database();
        await db.collection('asset_metadata').insertOne(metadata);
    }

    private async get_asset_metadata(asset_id: string): Promise<AssetMetadata | null> {
        const db = get_database();
        const metadata = await db.collection('asset_metadata').findOne({ asset_id });
        
        if (!metadata) {
            return null;
        }
        
        // Convert MongoDB document to AssetMetadata type
        return {
            asset_id: metadata.asset_id,
            user_id: metadata.user_id,
            session_id: metadata.session_id,
            original_filename: metadata.original_filename,
            content_type: metadata.content_type,
            file_size: metadata.file_size,
            s3_key: metadata.s3_key,
            s3_bucket: metadata.s3_bucket,
            s3_url: metadata.s3_url,
            cdn_url: metadata.cdn_url,
            created_at: metadata.created_at,
            last_accessed: metadata.last_accessed,
            access_count: metadata.access_count,
            tags: metadata.tags,
            lifecycle_policy: metadata.lifecycle_policy
        };
    }

    private async track_asset_access(asset_id: string): Promise<void> {
        const db = get_database();
        await db.collection('asset_metadata').updateOne(
            { asset_id },
            { 
                $inc: { access_count: 1 },
                $set: { last_accessed: new Date() }
            }
        );
    }

    private async remove_asset_metadata(asset_id: string): Promise<boolean> {
        const db = get_database();
        const result = await db.collection('asset_metadata').deleteOne({ asset_id });
        return result.deletedCount > 0;
    }

    private format_bytes(bytes: number): string {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }
    /**
     * Get file content from MinIO as a buffer.
     * Used to inject file contents into the chat context.
     */
    async get_file_content(asset_id: string): Promise<{ buffer: Buffer; content_type: string; filename: string }> {
        const metadata = await this.get_asset_metadata(asset_id);
        if (!metadata) {
            throw new Error(`Asset not found: ${asset_id}`);
        }

        const command = new GetObjectCommand({
            Bucket: metadata.s3_bucket,
            Key: metadata.s3_key,
        });

        const response = await this.s3_client.send(command);
        const chunks: Buffer[] = [];
        
        if (response.Body) {
            // response.Body can be a Readable stream or Blob
            const body = response.Body as any;
            if (typeof body.on === 'function') {
                // Node.js Readable stream
                for await (const chunk of body) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
            } else if (typeof body.arrayBuffer === 'function') {
                // Browser-like Blob
                const arrayBuf = await body.arrayBuffer();
                chunks.push(Buffer.from(arrayBuf));
            } else if (typeof body.transformToByteArray === 'function') {
                chunks.push(Buffer.from(await body.transformToByteArray()));
            }
        }

        console.log(`📄 Read ${chunks.reduce((s, c) => s + c.length, 0)} bytes from MinIO: ${metadata.original_filename}`);
        return {
            buffer: Buffer.concat(chunks),
            content_type: metadata.content_type,
            filename: metadata.original_filename,
        };
    }
}

// Export singleton instance
export const s3_asset_service = new S3AssetService();