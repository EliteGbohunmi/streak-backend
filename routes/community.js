const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { notifyUser } = require('../notificationService');

// GET all posts with comments
router.get('/posts', async (req, res) => {
  try {
    const { data: posts, error } = await supabase
      .from('community_posts')
      .select(`
        *,
        profiles!community_posts_user_id_fkey (id, name, email),
        comments: community_comments (id, content, user_id, created_at, profiles!community_comments_user_id_fkey (name))
      `)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST a new message – sends notifications to all other users
router.post('/posts', async (req, res) => {
  const { user_id, content, link } = req.body;
  if (!user_id || !content) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { data: post, error } = await supabase
      .from('community_posts')
      .insert([{ user_id, content, link }])
      .select();
    if (error) throw error;
    const newPost = post[0];

    const { data: author } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', user_id)
      .single();

    const { data: allUsers } = await supabase
      .from('profiles')
      .select('id')
      .neq('id', user_id);

    for (const u of allUsers || []) {
      await notifyUser(
        u.id,
        '📢 New community post',
        `${author?.name || 'Someone'} posted: ${content.substring(0, 60)}...`,
        { action: 'community' }
      );
    }

    res.json(newPost);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a post (owner only)
router.delete('/posts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('community_posts').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST a comment (reply) – notifies the post author
router.post('/comments', async (req, res) => {
  const { post_id, user_id, content } = req.body;
  if (!post_id || !user_id || !content) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { data: comment, error } = await supabase
      .from('community_comments')
      .insert([{ post_id, user_id, content }])
      .select();
    if (error) throw error;
    const newComment = comment[0];

    const { data: post } = await supabase
      .from('community_posts')
      .select('user_id')
      .eq('id', post_id)
      .single();

    const { data: replier } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', user_id)
      .single();

    if (post && post.user_id !== user_id) {
      await notifyUser(
        post.user_id,
        '💬 New reply to your post',
        `${replier?.name || 'Someone'} replied: ${content.substring(0, 60)}...`,
        { action: 'community' }
      );
    }

    res.json(newComment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a comment (owner only)
router.delete('/comments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('community_comments').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
