const router = require('express').Router();
const ctrl = require('../controllers/resources.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/resources/search', ctrl.searchResources);
router.get('/playlists', ctrl.listPlaylists);
router.post('/playlists', ctrl.createPlaylist);
router.get('/playlists/:id', ctrl.getPlaylist);
router.patch('/playlists/:id', ctrl.updatePlaylist);
router.delete('/playlists/:id', ctrl.deletePlaylist);

module.exports = router;
